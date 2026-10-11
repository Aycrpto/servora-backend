/**
 * Escrow money movements — release (pay the pro) and refund (repay the
 * customer). These do I/O + Paystack calls, so they live here rather than in
 * the pure escrow.js. Shared by the payments release endpoint, the split-escrow
 * quote flow, AND dispute resolution so the money logic exists in exactly one
 * place.
 *
 * Each returns a plain result object: { ok, code?, error?, ...data } — callers
 * map it to HTTP.
 *
 * Concurrency: every release CLAIMS its row with a compare-and-set UPDATE
 * (e.g. in_escrow → release_pending) in a committed transaction BEFORE calling
 * Paystack, so two simultaneous requests can never both send money. Paystack
 * calls always happen outside a database transaction.
 */
import { withTransaction } from '../db/pool.js';
import * as paystack from './paystack.js';
import { TX_STATUS, BOOKING_STATUS, genReference, canTransition } from './escrow.js';
import { getPro } from '../store/professionals.js';
import { getBooking, transitionBooking } from '../store/bookings.js';
import {
  getTxByReference, updateTx, claimTxStatus, updateStage, recordEvent,
} from '../store/transactions.js';

const now = () => new Date().toISOString();

/**
 * The pro's Paystack transfer recipient, set when they saved a payout account
 * (POST /api/pros/:id/payout). The full account number is never stored, so
 * there is nothing to create a recipient from here — no recipient, no payout.
 */
function recipientFor(pro) {
  const recipientCode = pro?.payout?.recipientCode || null;
  return recipientCode
    ? { ok: true, recipientCode }
    : { ok: false, code: 422, error: 'Professional has no payout bank account on file.' };
}

/**
 * Release the pro's share for an in-escrow SINGLE-AMOUNT transaction whose
 * booking is confirmed. Commission stays in Servora's balance; only
 * proPayoutKobo is transferred. Idempotent: the row is claimed before the
 * transfer and keeps its transfer reference, so a retry can't double-send.
 */
export async function releaseEscrow(reference, actor = 'admin', { requireConfirmed = true } = {}) {
  const tx = await getTxByReference(reference);
  if (!tx) return { ok: false, code: 404, error: 'Transaction not found.' };
  if (tx.status !== TX_STATUS.IN_ESCROW) {
    return { ok: false, code: 409, error: `Funds are not in escrow (status: ${tx.status}).` };
  }
  const booking = await getBooking(tx.bookingId);
  if (!booking) return { ok: false, code: 404, error: 'Booking not found.' };
  // Dispute resolution releases a 'disputed' booking, so it opts out of this check.
  if (requireConfirmed && booking.status !== BOOKING_STATUS.CONFIRMED) {
    return { ok: false, code: 409, error: `Job not confirmed yet (booking status: ${booking.status}).` };
  }
  const pro = await getPro(tx.proId);
  if (!pro) return { ok: false, code: 404, error: 'Professional not found.' };
  const recip = recipientFor(pro);
  if (!recip.ok) return recip;
  const { recipientCode } = recip;

  // Claim the row (in_escrow → release_pending) before transferring.
  const transferReference = genReference('TRF');
  const claimed = await withTransaction(async (c) => {
    const won = await claimTxStatus(c, tx.id, TX_STATUS.IN_ESCROW, TX_STATUS.RELEASE_PENDING,
      { payout: { recipientCode, transferReference } });
    if (won) {
      await recordEvent(c, tx, { type: 'release_initiated', fromStatus: TX_STATUS.IN_ESCROW,
        toStatus: TX_STATUS.RELEASE_PENDING, actor, data: { payoutKobo: tx.proPayoutKobo } });
    }
    return won;
  });
  if (!claimed) return { ok: false, code: 409, error: 'Funds are no longer releasable (already processing).' };

  try {
    const transfer = await paystack.initiateTransfer({
      amountKobo: tx.proPayoutKobo, recipientCode, reference: transferReference,
      reason: `Servora payout for booking ${tx.bookingId}`,
    });
    await withTransaction(async (c) => {
      const transferCode = transfer.transfer_code || null;
      // Integrations without transfer OTP answer 'success' immediately; otherwise
      // the transfer.success webhook finalises it.
      if (transfer.status === 'success' &&
          await claimTxStatus(c, tx.id, TX_STATUS.RELEASE_PENDING, TX_STATUS.RELEASED,
            { payout: { transferCode, transferredAt: now() } })) {
        await recordEvent(c, tx, { type: 'transfer_success', fromStatus: TX_STATUS.RELEASE_PENDING,
          toStatus: TX_STATUS.RELEASED, actor: 'system' });
        await transitionBooking(c, tx.bookingId, BOOKING_STATUS.CLOSED,
          { actor: 'system', note: 'Payment released to professional' });
      } else {
        await updateTx(c, tx.id, { payout: { transferCode } });
      }
    });
    return {
      ok: true, status: transfer.status, transferCode: transfer.transfer_code || null,
      payoutKobo: tx.proPayoutKobo, commissionKobo: tx.commissionKobo,
    };
  } catch (transferErr) {
    // Mark release_failed (retryable). The same transferReference is kept so a
    // retry is idempotent on Paystack's side (no double payout).
    await withTransaction(async (c) => {
      if (await claimTxStatus(c, tx.id, TX_STATUS.RELEASE_PENDING, TX_STATUS.RELEASE_FAILED,
        { payout: { failureReason: transferErr.message } })) {
        await recordEvent(c, tx, { type: 'transfer_failed', fromStatus: TX_STATUS.RELEASE_PENDING,
          toStatus: TX_STATUS.RELEASE_FAILED, actor: 'system', data: { reason: transferErr.message } });
      }
    });
    return { ok: false, code: 502, error: 'Payment gateway error during transfer.' };
  }
}

/**
 * Release one stage of a SPLIT-ESCROW (quote) transaction.
 *
 *   stage1 (materials milestone): in_escrow → partially_released, booking → in_progress
 *   stage2 (completion milestone): partially_released → released, booking → completed
 *
 * Each stage has its own micro-status ('held' → 'release_pending' →
 * 'released' | 'release_failed'), claimed by compare-and-set, so a stage can
 * never be paid twice and a failed transfer is retryable.
 */
async function releaseStage(reference, stageKey, { requireTxStatus, nextTxStatus, bookingStatusOnSuccess, actor }) {
  const tx = await getTxByReference(reference);
  if (!tx) return { ok: false, code: 404, error: 'Transaction not found.' };
  if (!tx.split) return { ok: false, code: 409, error: 'Not a split-escrow transaction.' };
  if (tx.status !== requireTxStatus) {
    return { ok: false, code: 409, error: `Funds are not at this release stage (status: ${tx.status}).` };
  }
  const stage = tx.split[stageKey];
  if (!stage) return { ok: false, code: 409, error: 'Unknown release stage.' };
  if (stage.status === 'released') return { ok: false, code: 409, error: 'This stage was already released.' };

  const payoutKobo = stage.payoutKobo || 0;
  const label = stageKey === 'stage1' ? 'Materials' : 'Labour';

  /** Log the released stage and move the job forward (same transaction as the money state). */
  const afterRelease = async (c, eventData, historyNote, eventActor) => {
    await recordEvent(c, tx, { type: `${stageKey}_released`, fromStatus: requireTxStatus,
      toStatus: nextTxStatus, actor: eventActor, data: eventData });
    if (bookingStatusOnSuccess) {
      await transitionBooking(c, tx.bookingId, bookingStatusOnSuccess, { actor, note: historyNote });
    }
  };

  // Nothing to send (a labour-only quote has no materials, or vice versa):
  // advance the state without a transfer. Both claims must succeed, or the
  // whole change rolls back.
  if (payoutKobo <= 0) {
    const stale = Symbol('stale');
    const done = await withTransaction(async (c) => {
      const stageWon = await updateStage(c, tx.id, stageKey, { status: 'released', transferredAt: now() },
        { fromStatuses: ['held', 'release_failed'] });
      if (!stageWon || !await claimTxStatus(c, tx.id, requireTxStatus, nextTxStatus)) throw stale;
      await afterRelease(c, { payoutKobo: 0, note: 'nothing to transfer' }, `${stageKey} released (₦0)`, actor);
      return true;
    }).catch((err) => { if (err === stale) return false; throw err; });
    if (!done) return { ok: false, code: 409, error: 'This stage is no longer releasable (already processing).' };
    return { ok: true, status: 'success', stage: stageKey, payoutKobo: 0 };
  }

  const pro = await getPro(tx.proId);
  if (!pro) return { ok: false, code: 404, error: 'Professional not found.' };
  const recip = recipientFor(pro);
  if (!recip.ok) return recip;
  const { recipientCode } = recip;

  // Claim this stage (held|release_failed → release_pending) while the
  // transaction is still at the required status.
  const transferReference = genReference('TRF');
  const claimed = await withTransaction(async (c) => {
    const t = await getTxByReference(reference, c, { forUpdate: true });
    if (!t || t.status !== requireTxStatus) return false;
    const won = await updateStage(c, tx.id, stageKey,
      { status: 'release_pending', recipientCode, transferReference },
      { fromStatuses: ['held', 'release_failed'] });
    if (won) await recordEvent(c, tx, { type: `${stageKey}_release_initiated`, actor, data: { payoutKobo } });
    return won;
  });
  if (!claimed) return { ok: false, code: 409, error: 'This stage is no longer releasable (already processing).' };

  try {
    const transfer = await paystack.initiateTransfer({
      amountKobo: payoutKobo, recipientCode, reference: transferReference,
      reason: `Servora ${stageKey === 'stage1' ? 'materials' : 'labour'} payout for booking ${tx.bookingId}`,
    });
    await withTransaction(async (c) => {
      const transferCode = transfer.transfer_code || null;
      if (transfer.status === 'success') {
        // The money has moved: record it as released unconditionally.
        await updateStage(c, tx.id, stageKey, { status: 'released', transferredAt: now(), transferCode });
        await updateTx(c, tx.id, { status: nextTxStatus });
        await afterRelease(c, { payoutKobo }, `${label} released to professional`, 'system');
      } else {
        await updateStage(c, tx.id, stageKey, { transferCode });
      }
    });
    return { ok: true, status: transfer.status, stage: stageKey, transferCode: transfer.transfer_code || null, payoutKobo };
  } catch (err) {
    await withTransaction(async (c) => {
      if (await updateStage(c, tx.id, stageKey, { status: 'release_failed', failureReason: err.message },
        { fromStatuses: ['release_pending'] })) {
        await recordEvent(c, tx, { type: `${stageKey}_release_failed`, actor: 'system', data: { reason: err.message } });
      }
    });
    return { ok: false, code: 502, error: 'Payment gateway error during transfer.' };
  }
}

/** Stage 1 — release materials (+ net inspection) after the customer approves. */
export const releaseMaterials = (reference, actor = 'customer') =>
  releaseStage(reference, 'stage1', {
    requireTxStatus: TX_STATUS.IN_ESCROW,
    nextTxStatus: TX_STATUS.PARTIALLY_RELEASED,
    bookingStatusOnSuccess: BOOKING_STATUS.IN_PROGRESS,
    actor,
  });

/** Stage 2 — release labour (net commission) once the customer is satisfied. */
export const releaseLabour = (reference, actor = 'customer') =>
  releaseStage(reference, 'stage2', {
    requireTxStatus: TX_STATUS.PARTIALLY_RELEASED,
    nextTxStatus: TX_STATUS.RELEASED,
    bookingStatusOnSuccess: BOOKING_STATUS.COMPLETED,
    actor,
  });

/**
 * Refund the customer. Handles both models:
 *   - in_escrow (simple, or split before materials release) → refund the FULL amount.
 *   - partially_released (split, materials already released) → refund only the
 *     still-held labour portion; the released materials stay with the pro.
 * Marks the transaction refunded and cancels the booking. Paystack processes
 * the refund asynchronously; we record it as initiated here.
 */
export async function refundEscrow(reference, { reason = 'Dispute resolved in customer favour', actor = 'admin' } = {}) {
  const tx = await getTxByReference(reference);
  if (!tx) return { ok: false, code: 404, error: 'Transaction not found.' };

  const isPartial = tx.status === TX_STATUS.PARTIALLY_RELEASED;
  if (tx.status !== TX_STATUS.IN_ESCROW && !isPartial) {
    return { ok: false, code: 409, error: `Funds are not refundable (status: ${tx.status}).` };
  }
  if (!canTransition(tx.status, TX_STATUS.REFUNDED)) {
    return { ok: false, code: 409, error: 'Transaction is not refundable.' };
  }

  // Full amount if nothing has been released; otherwise only the held labour.
  const refundKobo = isPartial ? (tx.split?.labourKobo ?? 0) : tx.amountKobo;
  if (!(refundKobo > 0)) return { ok: false, code: 409, error: 'Nothing left to refund.' };

  try {
    await paystack.refundTransaction({ reference, amountKobo: refundKobo });
  } catch {
    return { ok: false, code: 502, error: 'Payment gateway error during refund.' };
  }
  await withTransaction(async (c) => {
    const from = tx.status;
    if (!await claimTxStatus(c, tx.id, from, TX_STATUS.REFUNDED,
      { refund: { refundedAt: now(), reason, amountKobo: refundKobo, partial: isPartial } })) return;
    await recordEvent(c, tx, { type: 'refunded', fromStatus: from, toStatus: TX_STATUS.REFUNDED, actor,
      data: { reason, amountKobo: refundKobo, partial: isPartial } });
    await transitionBooking(c, tx.bookingId, BOOKING_STATUS.CANCELLED,
      { actor, note: isPartial ? 'Labour refunded (materials already released)' : 'Refunded to customer' });
  });
  return { ok: true, status: 'refunded', amountKobo: refundKobo, partial: isPartial };
}
