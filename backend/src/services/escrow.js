/**
 * Escrow domain logic — money math, the escrow state machine, and the audit log.
 * Pure/synchronous helpers (no I/O) so controllers stay thin and testable.
 */
import { randomUUID } from 'node:crypto';
import { SERVORA_COMMISSION_BPS } from '../config.js';

/** Money (escrow) status — the lifecycle of the funds. */
export const TX_STATUS = {
  PENDING: 'pending',                 // initialized, awaiting payment
  IN_ESCROW: 'in_escrow',             // paid, held in Servora's balance
  RELEASE_PENDING: 'release_pending', // transfer initiated, awaiting confirmation
  RELEASED: 'released',               // pro paid out
  REFUNDED: 'refunded',               // returned to customer
  FAILED: 'failed',                   // charge never succeeded
  RELEASE_FAILED: 'release_failed',   // transfer failed — retryable
};

/** Booking (job) status — the lifecycle of the work.
 *   pending_payment → funded → in_progress → awaiting_confirmation
 *        → confirmed → closed        (happy path)
 *   awaiting_confirmation → disputed (pro escalates after 24h)
 *   disputed → confirmed (release) | cancelled (refund)   (Support decides) */
export const BOOKING_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  FUNDED: 'funded',
  IN_PROGRESS: 'in_progress',
  AWAITING_CONFIRMATION: 'awaiting_confirmation', // pro marked done, customer must confirm
  CONFIRMED: 'confirmed',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
  DISPUTED: 'disputed',
};

/** How long after a pro marks a job complete before they can open a dispute. */
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Allowed money transitions. Anything not listed is rejected. */
const TX_TRANSITIONS = {
  pending: ['in_escrow', 'failed'],
  in_escrow: ['release_pending', 'refunded'],
  release_pending: ['released', 'release_failed'],
  release_failed: ['release_pending', 'refunded'], // retry or refund
  released: [],   // terminal
  refunded: [],   // terminal
  failed: [],     // terminal
};
export const canTransition = (from, to) => (TX_TRANSITIONS[from] || []).includes(to);

/**
 * Split an amount into Servora's commission and the pro's payout.
 * All integer KOBO — commission is rounded, payout is the remainder so the
 * invariant amount === commission + payout always holds.
 */
export function computeSplit(amountKobo, bps = SERVORA_COMMISSION_BPS) {
  const commissionKobo = Math.round((amountKobo * bps) / 10000);
  return { commissionBps: bps, commissionKobo, proPayoutKobo: amountKobo - commissionKobo };
}

/** Our own unique reference — the idempotency key for a charge or transfer. */
export const genReference = (prefix = 'SRV') => `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;

/**
 * Append an immutable audit event. Call inside a mutate() so it's written
 * atomically with the status change it describes. Never mutate/delete events.
 */
export function recordEvent(db, tx, { type, fromStatus = null, toStatus = null, actor = 'system', data = {} }) {
  db.transactionEvents.push({
    id: randomUUID(),
    transactionId: tx.id,
    reference: tx.reference,
    type, fromStatus, toStatus, actor, data,
    createdAt: new Date().toISOString(),
  });
}
