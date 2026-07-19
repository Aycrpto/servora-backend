/**
 * Escrow domain logic — money math, the escrow state machine, and the audit log.
 * Pure/synchronous helpers (no I/O) so controllers stay thin and testable.
 */
import { randomUUID } from 'node:crypto';
import { SERVORA_COMMISSION_BPS } from '../config.js';

/** Money (escrow) status — the lifecycle of the funds. */
export const TX_STATUS = {
  PENDING: 'pending',                       // initialized, awaiting payment
  IN_ESCROW: 'in_escrow',                   // paid, held in Servora's balance
  RELEASE_PENDING: 'release_pending',       // transfer initiated, awaiting confirmation
  PARTIALLY_RELEASED: 'partially_released', // split escrow: materials paid, labour still held
  RELEASED: 'released',                     // pro fully paid out
  REFUNDED: 'refunded',                     // returned to customer
  FAILED: 'failed',                         // charge never succeeded
  RELEASE_FAILED: 'release_failed',         // transfer failed — retryable
};

/**
 * Booking (job) status — the lifecycle of the work.
 *
 * Legacy single-amount flow (a "simple" booking):
 *   pending_payment → funded → in_progress → awaiting_confirmation
 *        → confirmed → closed                     (happy path)
 *   awaiting_confirmation → disputed              (pro escalates after 24h)
 *
 * Quote-based split-escrow flow (a "quote" booking):
 *   pending_payment → funded                      (customer pays full quote)
 *     → awaiting_material_approval                (pro uploaded pre-job evidence, ready to start)
 *     → in_progress                               (customer approved → materials released)
 *     → awaiting_completion_review                (pro uploaded completion evidence)
 *     → completed                                 (customer satisfied → labour released)
 *   awaiting_completion_review → redo_in_progress (customer requests the one allowed redo)
 *     → awaiting_redo_review → completed          (satisfied after redo)
 *   awaiting_redo_review → disputed               (still not satisfied → Support decides)
 */
export const BOOKING_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  FUNDED: 'funded',
  // Quote flow — pre-work
  AWAITING_MATERIAL_APPROVAL: 'awaiting_material_approval', // pro ready; customer must approve materials
  IN_PROGRESS: 'in_progress',                               // materials released, work underway
  // Quote flow — completion
  AWAITING_COMPLETION_REVIEW: 'awaiting_completion_review', // pro done; customer reviews
  REDO_IN_PROGRESS: 'redo_in_progress',                     // customer asked for the one allowed redo
  AWAITING_REDO_REVIEW: 'awaiting_redo_review',             // pro redid; customer reviews again
  COMPLETED: 'completed',                                   // labour released, job closed (quote flow)
  // Legacy single-amount flow
  AWAITING_CONFIRMATION: 'awaiting_confirmation',           // pro marked done, customer must confirm
  CONFIRMED: 'confirmed',
  CLOSED: 'closed',
  // Shared terminal / exception states
  CANCELLED: 'cancelled',
  DISPUTED: 'disputed',
};

/** How long after a pro marks a job complete before they can open a dispute. */
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Pre-job evidence is MANDATORY before any work begins: the pro must document
 * the site with at least this many clear photos and one short video. Completion
 * (and redo) evidence proves the finished work — photos required, video optional.
 */
export const EVIDENCE_RULES = {
  pre_job:    { minPhotos: 2, minVideos: 1 },
  completion: { minPhotos: 2, minVideos: 0 },
  redo:       { minPhotos: 2, minVideos: 0 },
};
export const EVIDENCE_PHASES = Object.keys(EVIDENCE_RULES);

/** Allowed money transitions. Anything not listed is rejected. */
const TX_TRANSITIONS = {
  pending: ['in_escrow', 'failed'],
  in_escrow: ['release_pending', 'partially_released', 'refunded'],
  release_pending: ['released', 'release_failed'],
  release_failed: ['release_pending', 'refunded'],
  partially_released: ['released', 'refunded'], // labour released, or remainder refunded
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

/**
 * Split a QUOTE into the two escrow release stages.
 *
 *   Stage 1 (materials milestone, released after the customer approves):
 *       materials  → paid 100% to the pro (pass-through, no commission)
 *       inspection → paid to the pro net of commission
 *   Stage 2 (completion milestone, released when the customer is satisfied):
 *       labour     → paid to the pro net of commission
 *
 * Commission is charged on LABOUR + INSPECTION only; materials are a pure
 * pass-through. Everything is integer kobo and the invariant holds exactly:
 *   total === stage1PayoutKobo + stage2PayoutKobo + totalCommissionKobo
 */
export function computeQuoteSplit(materialsKobo, labourKobo, inspectionKobo = 0, bps = SERVORA_COMMISSION_BPS) {
  const m = Math.max(0, Math.round(materialsKobo || 0));
  const l = Math.max(0, Math.round(labourKobo || 0));
  const i = Math.max(0, Math.round(inspectionKobo || 0));

  const inspectionCommissionKobo = Math.round((i * bps) / 10000);
  const labourCommissionKobo = Math.round((l * bps) / 10000);

  const stage1PayoutKobo = m + (i - inspectionCommissionKobo); // materials (full) + inspection (net)
  const stage2PayoutKobo = l - labourCommissionKobo;           // labour (net)
  const totalCommissionKobo = inspectionCommissionKobo + labourCommissionKobo;

  return {
    commissionBps: bps,
    materialsKobo: m, labourKobo: l, inspectionKobo: i,
    totalKobo: m + l + i,
    inspectionCommissionKobo, labourCommissionKobo, totalCommissionKobo,
    stage1PayoutKobo, stage2PayoutKobo,
  };
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

/**
 * Append a booking status-history entry. Kept on the booking itself (b.history)
 * so both parties can see a plain, ordered timeline of what happened and when.
 * Call inside a mutate() alongside the status change.
 */
export function pushBookingHistory(b, status, actor = 'system', note = null) {
  if (!Array.isArray(b.history)) b.history = [];
  b.history.push({ status, actor, note, at: new Date().toISOString() });
}
