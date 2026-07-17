/**
 * Escrow money movements — release (pay the pro) and refund (repay the
 * customer). These do I/O + Paystack calls, so they live here rather than in
 * the pure escrow.js. Shared by the payments release endpoint AND dispute
 * resolution so the money logic exists in exactly one place.
 *
 * Each returns a plain result object: { ok, code?, error?, ...data } — callers
 * map it to HTTP. All state changes go through mutate() and the audit log.
 */
import { loadDB, mutate } from '../store/store.js';
import * as paystack from './paystack.js';
import { TX_STATUS, BOOKING_STATUS, genReference, canTransition, recordEvent } from './escrow.js';

const now = () => new Date().toISOString();

/**
 * Release the pro's share for an in-escrow transaction whose booking is
 * confirmed. Commission stays in Servora's balance; only proPayoutKobo is
 * transferred. Guarded + idempotent (claims the row under lock before the
 * transfer, keeps the transfer reference so retries can't double-send).
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

  // Resolve the payout recipient (reuse stored recipient_code, or create one).
  let recipientCode = pro.payout?.recipientCode || null;
  if (!recipientCode) {
    const bank = pro.payout || {};
    if (!bank.accountNumber || !bank.bankCode) {
      return { ok: false, code: 422, error: 'Professional has no payout bank account on file.' };
    }
    try {
      const recip = await paystack.createTransferRecipient({ name: pro.name, accountNumber: bank.accountNumber, bankCode: bank.bankCode });
      recipientCode = recip.recipient_code;
      await mutate((d) => {
        const p = d.professionals.find((x) => String(x.id) === String(pro.id));
        if (p) p.payout = { ...(p.payout || {}), recipientCode, verified: true, updatedAt: now() };
      });
    } catch (err) {
      return { ok: false, code: 502, error: 'Payment gateway error creating payout recipient.' };
    }
  }

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
        if (b) { b.status = BOOKING_STATUS.CLOSED; b.updatedAt = now(); }
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
 * Refund an in-escrow charge back to the customer (dispute resolved in their
 * favour). Marks the transaction refunded and cancels the booking. Paystack
 * processes the refund asynchronously; we record it as initiated here.
 */
export async function refundEscrow(reference, { reason = 'Dispute resolved in customer favour', actor = 'admin' } = {}) {
  const db = loadDB();
  const tx = db.transactions.find((t) => t.reference === reference);
  if (!tx) return { ok: false, code: 404, error: 'Transaction not found.' };
  if (tx.status !== TX_STATUS.IN_ESCROW) {
    return { ok: false, code: 409, error: `Funds are not in escrow (status: ${tx.status}).` };
  }
  if (!canTransition(tx.status, TX_STATUS.REFUNDED)) {
    return { ok: false, code: 409, error: 'Transaction is not refundable.' };
  }
  try {
    await paystack.refundTransaction({ reference, amountKobo: tx.amountKobo });
  } catch (err) {
    return { ok: false, code: 502, error: 'Payment gateway error during refund.' };
  }
  await mutate((d) => {
    const t = d.transactions.find((x) => x.reference === reference);
    if (!t) return;
    const from = t.status;
    t.status = TX_STATUS.REFUNDED;
    t.refund = { refundedAt: now(), reason, amountKobo: t.amountKobo };
    t.updatedAt = now();
    recordEvent(d, t, { type: 'refunded', fromStatus: from, toStatus: TX_STATUS.REFUNDED, actor, data: { reason } });
    const b = d.bookings.find((x) => x.id === t.bookingId);
    if (b) { b.status = BOOKING_STATUS.CANCELLED; b.updatedAt = now(); }
  });
  return { ok: true, status: 'refunded', amountKobo: tx.amountKobo };
}
