/**
 * Escrow money movements — release (pay the pro) and refund (repay the
 * customer). These do I/O + Paystack calls, so they live here rather than in
 * the pure escrow.js. Shared by the payments release endpoint, the split-escrow
 * quote flow, AND dispute resolution so the money logic exists in exactly one
 * place.
 *
 * Each returns a plain result object: { ok, code?, error?, ...data } — callers
 * map it to HTTP. All state changes go through mutate() and the audit log.
 */
import { loadDB, mutate } from '../store/store.js';
import * as paystack from './paystack.js';
import {
  TX_STATUS, BOOKING_STATUS, genReference, canTransition, recordEvent, pushBookingHistory,
} from './escrow.js';

const now = () => new Date().toISOString();

/**
 * Resolve a pro's Paystack transfer recipient — reuse a stored recipient_code
 * or create (and persist) one from their payout bank account. Shared by every
 * payout path. Returns { ok, recipientCode } or an error result.
 */
async function resolveRecipientCode(pro) {
  let recipientCode = pro.payout?.recipientCode || null;
  if (recipientCode) return { ok: true, recipientCode };

  const bank = pro.payout || {};
  if (!bank.accountNumber || !bank.bankCode) {
    return { ok: false, code: 422, error: 'Professional has no payout bank account on file.' };
  }
  try {
    const recip = await paystack.createTransferRecipient({
      name: pro.name, accountNumber: bank.accountNumber, bankCode: bank.bankCode,
    });
    recipientCode = recip.recipient_code;
    await mutate((d) => {
      const p = d.professionals.find((x) => String(x.id) === String(pro.id));
      if (p) p.payout = { ...(p.payout || {}), recipientCode, verified: true, updatedAt: now() };
    });
    return { ok: true, recipientCode };
  } catch {
    return { ok: false, code: 502, error: 'Payment gateway error creating payout recipient.' };
  }
}

/**
 * Release the pro's share for an in-escrow SINGLE-AMOUNT transaction whose
 * booking is confirmed. Commission stays in Servora's balance; only
 * proPayoutKobo is transferred. Guarded + idempotent (claims the row under lock
 * before the transfer, keeps the transfer reference so retries can't double-send).
 */
export async function releaseEscrow(reference, actor = 'admin', { requireConfirmed = true } = {}) {
  const db = loadDB();
  const tx = db.transactions.find((t) => t.reference === reference);
  if (!tx) return { ok: false, code: 404, error: 'Transaction not found.' };
  if (tx.status !== TX_STATUS.IN_ESCROW) {
    return { ok: false, code: 409, error: `Funds are not in escrow (status: ${tx.status}).` };
  }
  const booking = db.bookings.find((b) => b.id === tx.bookingId);
  if (!booking) return { ok: false, code: 404, error: 'Booking not found.' };
  // Dispute resolution releases a 'disputed' booking, so it opts out of this check.
  if (requireConfirmed && booking.status !== BOOKING_STATUS.CONFIRMED) {
    return { ok: false, code: 409, error: `Job not confirmed yet (booking status: ${booking.status}).` };
  }
  const pro = db.professionals.find((p) => String(p.id) === String(tx.proId));
  if (!pro) return { ok: false, code: 404, error: 'Professional not found.' };

  const recip = await resolveRecipientCode(pro);
  if (!recip.ok) return recip;
  const { recipientCode } = recip;

  // Claim the row (in_escrow → release_pending) UNDER LOCK before transferring.
  const transferReference = genReference('TRF');
  const claimed = await mutate((d) => {
    const t = d.transactions.find((x) => x.reference === reference);
    if (!t || t.status !== TX_STATUS.IN_ESCROW || !canTransition(t.status, TX_STATUS.RELEASE_PENDING)) return false;
    t.status = TX_STATUS.RELEASE_PENDING;
    t.payout.recipientCode = recipientCode;
    t.payout.transferReference = transferReference;
    t.updatedAt = now();
    recordEvent(d, t, { type: 'release_initiated', fromStatus: TX_STATUS.IN_ESCROW, toStatus: TX_STATUS.RELEASE_PENDING, actor, data: { payoutKobo: t.proPayoutKobo } });
    return true;
  });
  if (!claimed) return { ok: false, code: 409, error: 'Funds are no longer releasable (already processing).' };

  try {
    const transfer = await paystack.initiateTransfer({
      amountKobo: tx.proPayoutKobo, recipientCode, reference: transferReference,
      reason: `Servora payout for booking ${tx.bookingId}`,
    });
    await mutate((d) => {
      const t = d.transactions.find((x) => x.reference === reference);
      if (!t) return;
      t.payout.transferCode = transfer.transfer_code || null;
      t.updatedAt = now();
      // OTP-off integrations return 'success' synchronously; else the webhook finalizes.
      if (transfer.status === 'success') {
        t.status = TX_STATUS.RELEASED;
        t.payout.transferredAt = now();
        recordEvent(d, t, { type: 'transfer_success', fromStatus: TX_STATUS.RELEASE_PENDING, toStatus: TX_STATUS.RELEASED, actor: 'system' });
        const b = d.bookings.find((x) => x.id === t.bookingId);
        if (b) { b.status = BOOKING_STATUS.CLOSED; b.updatedAt = now(); pushBookingHistory(b, BOOKING_STATUS.CLOSED, 'system', 'Payment released to professional'); }
      }
    });
    return {
      ok: true, status: transfer.status, transferCode: transfer.transfer_code || null,
      payoutKobo: tx.proPayoutKobo, commissionKobo: tx.commissionKobo,
    };
  } catch (transferErr) {
    // Mark release_failed (retryable) — keep the same transferReference so a
    // retry is idempotent on Paystack's side (no double payout).
    await mutate((d) => {
      const t = d.transactions.find((x) => x.reference === reference);
      if (t && t.status === TX_STATUS.RELEASE_PENDING) {
        t.status = TX_STATUS.RELEASE_FAILED;
        t.payout.failureReason = transferErr.message;
        t.updatedAt = now();
        recordEvent(d, t, { type: 'transfer_failed', fromStatus: TX_STATUS.RELEASE_PENDING, toStatus: TX_STATUS.RELEASE_FAILED, actor: 'system', data: { reason: transferErr.message } });
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
 * Each stage carries its own micro-status ('held' → 'release_pending' →
 * 'released' | 'release_failed') claimed under lock, so a stage can never be
 * paid twice and a failed transfer is retryable with the same reference.
 */
async function releaseStage(reference, stageKey, { requireTxStatus, nextTxStatus, bookingStatusOnSuccess, actor }) {
  const db = loadDB();
  const tx = db.transactions.find((t) => t.reference === reference);
  if (!tx) return { ok: false, code: 404, error: 'Transaction not found.' };
  if (!tx.split) return { ok: false, code: 409, error: 'Not a split-escrow transaction.' };
  if (tx.status !== requireTxStatus) {
    return { ok: false, code: 409, error: `Funds are not at this release stage (status: ${tx.status}).` };
  }
  const stage = tx.split[stageKey];
  if (!stage) return { ok: false, code: 409, error: 'Unknown release stage.' };
  if (stage.status === 'released') return { ok: false, code: 409, error: 'This stage was already released.' };

  const payoutKobo = stage.payoutKobo || 0;

  // Nothing to send (e.g. a labour-only quote has no materials to release, or a
  // materials-only quote has no labour). Advance the state without a transfer.
  if (payoutKobo <= 0) {
    await mutate((d) => {
      const t = d.transactions.find((x) => x.reference === reference);
      if (!t || t.status !== requireTxStatus) return;
      const s = t.split[stageKey];
      if (!s || s.status === 'released') return;
      s.status = 'released';
      s.transferredAt = now();
      t.status = nextTxStatus;
      t.updatedAt = now();
      recordEvent(d, t, { type: `${stageKey}_released`, fromStatus: requireTxStatus, toStatus: nextTxStatus, actor, data: { payoutKobo: 0, note: 'nothing to transfer' } });
      const b = d.bookings.find((x) => x.id === t.bookingId);
      if (b && bookingStatusOnSuccess) { b.status = bookingStatusOnSuccess; b.updatedAt = now(); pushBookingHistory(b, bookingStatusOnSuccess, actor, `${stageKey} released (₦0)`); }
    });
    return { ok: true, status: 'success', stage: stageKey, payoutKobo: 0 };
  }

  const pro = db.professionals.find((p) => String(p.id) === String(tx.proId));
  if (!pro) return { ok: false, code: 404, error: 'Professional not found.' };
  const recip = await resolveRecipientCode(pro);
  if (!recip.ok) return recip;
  const { recipientCode } = recip;

  // Claim this stage under lock (held|release_failed → release_pending).
  const transferReference = genReference('TRF');
  const claimed = await mutate((d) => {
    const t = d.transactions.find((x) => x.reference === reference);
    if (!t || t.status !== requireTxStatus) return false;
    const s = t.split?.[stageKey];
    if (!s || (s.status !== 'held' && s.status !== 'release_failed')) return false;
    s.status = 'release_pending';
    s.recipientCode = recipientCode;
    s.transferReference = transferReference;
    t.updatedAt = now();
    recordEvent(d, t, { type: `${stageKey}_release_initiated`, actor, data: { payoutKobo } });
    return true;
  });
  if (!claimed) return { ok: false, code: 409, error: 'This stage is no longer releasable (already processing).' };

  try {
    const transfer = await paystack.initiateTransfer({
      amountKobo: payoutKobo, recipientCode, reference: transferReference,
      reason: `Servora ${stageKey === 'stage1' ? 'materials' : 'labour'} payout for booking ${tx.bookingId}`,
    });
    await mutate((d) => {
      const t = d.transactions.find((x) => x.reference === reference);
      if (!t) return;
      const s = t.split[stageKey];
      s.transferCode = transfer.transfer_code || null;
      t.updatedAt = now();
      if (transfer.status === 'success') {
        s.status = 'released';
        s.transferredAt = now();
        t.status = nextTxStatus;
        recordEvent(d, t, { type: `${stageKey}_released`, fromStatus: requireTxStatus, toStatus: nextTxStatus, actor: 'system', data: { payoutKobo } });
        const b = d.bookings.find((x) => x.id === t.bookingId);
        if (b && bookingStatusOnSuccess) { b.status = bookingStatusOnSuccess; b.updatedAt = now(); pushBookingHistory(b, bookingStatusOnSuccess, actor, `${stageKey === 'stage1' ? 'Materials' : 'Labour'} released to professional`); }
      }
    });
    return { ok: true, status: transfer.status, stage: stageKey, transferCode: transfer.transfer_code || null, payoutKobo };
  } catch (err) {
    await mutate((d) => {
      const t = d.transactions.find((x) => x.reference === reference);
      const s = t?.split?.[stageKey];
      if (s && s.status === 'release_pending') {
        s.status = 'release_failed';
        s.failureReason = err.message;
        t.updatedAt = now();
        recordEvent(d, t, { type: `${stageKey}_release_failed`, actor: 'system', data: { reason: err.message } });
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
  const db = loadDB();
  const tx = db.transactions.find((t) => t.reference === reference);
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
  await mutate((d) => {
    const t = d.transactions.find((x) => x.reference === reference);
    if (!t) return;
    const from = t.status;
    t.status = TX_STATUS.REFUNDED;
    t.refund = { refundedAt: now(), reason, amountKobo: refundKobo, partial: isPartial };
    t.updatedAt = now();
    recordEvent(d, t, { type: 'refunded', fromStatus: from, toStatus: TX_STATUS.REFUNDED, actor, data: { reason, amountKobo: refundKobo, partial: isPartial } });
    const b = d.bookings.find((x) => x.id === t.bookingId);
    if (b) {
      b.status = BOOKING_STATUS.CANCELLED; b.updatedAt = now();
      pushBookingHistory(b, BOOKING_STATUS.CANCELLED, actor, isPartial ? 'Labour refunded (materials already released)' : 'Refunded to customer');
    }
  });
  return { ok: true, status: 'refunded', amountKobo: refundKobo, partial: isPartial };
}
