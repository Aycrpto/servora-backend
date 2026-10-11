/**
 * Bookings controller — the agreed job between a customer and a pro.
 *
 * Two shapes share this controller:
 *   • "simple" bookings — a single agreed amount, one payout after confirmation
 *     (start → complete → confirm). Legacy flow, unchanged.
 *   • "quote" bookings — an itemised quote paid into a two-stage split escrow
 *     (materials released after the customer approves, labour after completion).
 *     Adds pre-job/completion evidence, a material-approval gate, and a single
 *     redo before Support review.
 *
 * Customers still need no account; their capability is knowing the booking id.
 * Every state change locks the booking row (SELECT … FOR UPDATE) and commits
 * the new status, its timeline entry and any audit event together.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { BOOKING_STATUS, TX_STATUS, DISPUTE_WINDOW_MS, EVIDENCE_RULES } from '../services/escrow.js';
import { releaseEscrow, releaseMaterials, releaseLabour } from '../services/escrowActions.js';
import { persistEvidence } from '../store/uploads.js';
import { getPro } from '../store/professionals.js';
import {
  getBooking as loadBooking, insertBooking, addHistory, transitionBooking, touchBooking,
  insertEvidence, listEvidence, evidenceCounts,
} from '../store/bookings.js';
import { findBookingTx, latestBookingTx, recordEvent } from '../store/transactions.js';
import { insertDispute, getDispute } from '../store/disputes.js';

const now = () => new Date().toISOString();
const isPosInt = (n) => Number.isInteger(n) && n > 0;
const MIN_KOBO = 10000;          // ₦100 floor (sanity)
const MAX_KOBO = 500000000;      // ₦5,000,000 ceiling (sanity guard against fat-finger)

// Pro-only routes run requirePro first; the signed-in pro must be the job's pro.
const isAssignedPro = (req, b) => String(req.pro?.id) === String(b.proId);

const HELD = [TX_STATUS.IN_ESCROW, TX_STATUS.PARTIALLY_RELEASED];

const evidenceMet = (counts, phase) =>
  counts.photos >= EVIDENCE_RULES[phase].minPhotos && counts.videos >= EVIDENCE_RULES[phase].minVideos;

/** Minimal, PII-free transaction summary for the frontend timeline. */
function txSummary(t) {
  if (!t) return null;
  return {
    reference: t.reference,
    status: t.status,
    kind: t.kind || 'simple',
    amountKobo: t.amountKobo,
    split: t.split ? {
      materialsKobo: t.split.materialsKobo,
      labourKobo: t.split.labourKobo,
      inspectionKobo: t.split.inspectionKobo,
      stage1: { payoutKobo: t.split.stage1.payoutKobo, status: t.split.stage1.status },
      stage2: { payoutKobo: t.split.stage2.payoutKobo, status: t.split.stage2.status },
    } : null,
  };
}

/** Send a guarded state change's result: an {code,error} refusal, or the fresh booking. */
async function respond(res, result, extra = {}) {
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  const booking = await loadBooking(result.bookingId);
  res.json({ ok: true, booking, ...extra, ...(result.message ? { message: result.message } : {}) });
}

/**
 * POST /api/bookings
 * Body: { proId, service?, description?, amountNaira? | amountKobo?, customer:{ name?, email?, phone? } }
 * Creates a SIMPLE booking. (Quote bookings are created by accepting a quote.)
 * The amount is stored server-side and becomes the single source of truth for the charge.
 */
export async function createBooking(req, res) {
  const { proId, service, description, amountNaira, amountKobo, customer } = req.body || {};

  // Resolve amount (accept naira or kobo) and validate hard.
  let kobo = null;
  if (isPosInt(amountKobo)) kobo = amountKobo;
  else if (isPosInt(amountNaira)) kobo = amountNaira * 100;
  if (!kobo) return res.status(400).json({ ok: false, error: 'A valid amount (amountNaira or amountKobo) is required.' });
  if (kobo < MIN_KOBO) return res.status(400).json({ ok: false, error: 'Amount is below the ₦100 minimum.' });
  if (kobo > MAX_KOBO) return res.status(400).json({ ok: false, error: 'Amount exceeds the allowed maximum.' });

  const pro = await getPro(proId);
  if (!pro || pro.status !== 'verified') return res.status(404).json({ ok: false, error: 'Professional not found.' });

  if (!customer?.email && !customer?.phone) {
    return res.status(400).json({ ok: false, error: 'Customer email or phone is required.' });
  }

  const booking = {
    id: 'bk_' + randomUUID().slice(0, 12),
    proId: pro.id,
    kind: 'simple',
    service: service ?? pro.category,
    description: description ?? null,
    customer: {
      name: customer?.name ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    },
    agreedAmountKobo: kobo,
    status: BOOKING_STATUS.PENDING_PAYMENT,
    createdAt: now(),
  };
  await withTransaction(async (c) => {
    await insertBooking(c, booking);
    await addHistory(c, booking.id, BOOKING_STATUS.PENDING_PAYMENT, 'customer', 'Booking created — awaiting payment');
  });
  res.status(201).json({ ok: true, booking: await loadBooking(booking.id) });
}

/** GET /api/bookings/:id  — booking + its evidence + a payment summary. */
export async function getBooking(req, res) {
  const booking = await loadBooking(req.params.id);
  if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  const [evidence, tx] = await Promise.all([listEvidence(booking.id), latestBookingTx(booking.id)]);
  res.json({ ok: true, booking, evidence, transaction: txSummary(tx) });
}

/**
 * POST /api/bookings/:id/start   (Pro only) — SIMPLE bookings only.
 * The professional starts the job: funded → in_progress.
 */
export async function startJob(req, res) {
  const result = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (!isAssignedPro(req, b)) return { code: 403, error: 'Only the assigned professional can start this job.' };
    if (b.kind === 'quote') return { code: 409, error: 'Quote jobs start via the materials-approval flow, not /start.' };
    if (b.status !== BOOKING_STATUS.FUNDED) return { code: 409, error: `Can't start a job from status "${b.status}".` };
    await transitionBooking(c, b.id, BOOKING_STATUS.IN_PROGRESS, { actor: 'pro', note: 'Job started', set: { startedAt: now() } });
    return { bookingId: b.id, message: 'Job started.' };
  });
  return respond(res, result);
}

/* ============================================================
 * QUOTE FLOW — evidence, ready-to-start, material approval,
 * completion review, redo and escalation.
 * ==========================================================*/

/**
 * POST /api/bookings/:id/evidence   (Pro only)
 * Body: { phase: 'pre_job'|'completion'|'redo', photos?[], videos?[], note? }
 * Attaches evidence to a quote booking for the current phase. Counts are
 * enforced at the gates (/ready, /complete) — here we just require ≥1 valid item.
 */
export async function uploadEvidence(req, res) {
  const { phase, photos, videos, note } = req.body || {};
  if (!['pre_job', 'completion', 'redo'].includes(phase)) {
    return res.status(400).json({ ok: false, error: "phase must be 'pre_job', 'completion' or 'redo'." });
  }

  // Auth + phase/status precondition (read first so we don't persist media for a
  // request we'll reject).
  const pre = await loadBooking(req.params.id);
  if (!pre) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  if (!isAssignedPro(req, pre)) return res.status(403).json({ ok: false, error: 'Only the assigned professional can upload evidence.' });
  if (pre.kind !== 'quote') return res.status(409).json({ ok: false, error: 'Evidence applies to quote jobs only.' });

  const allowedStatus = {
    pre_job: [BOOKING_STATUS.FUNDED, BOOKING_STATUS.AWAITING_MATERIAL_APPROVAL],
    completion: [BOOKING_STATUS.IN_PROGRESS, BOOKING_STATUS.AWAITING_COMPLETION_REVIEW],
    redo: [BOOKING_STATUS.REDO_IN_PROGRESS, BOOKING_STATUS.AWAITING_REDO_REVIEW],
  }[phase];
  if (!allowedStatus.includes(pre.status)) {
    return res.status(409).json({ ok: false, error: `Can't upload ${phase} evidence while the job is "${pre.status}".` });
  }

  // Persist media (sync fs writes, no network) before the transaction.
  const stored = persistEvidence(photos, videos);
  if (!stored.photos.length && !stored.videos.length) {
    return res.status(400).json({ ok: false, error: 'Attach at least one valid photo or video.' });
  }

  const entry = {
    id: 'ev_' + randomUUID().slice(0, 12),
    bookingId: pre.id,
    proId: pre.proId,
    phase,
    photos: stored.photos,
    videos: stored.videos,
    note: note ? String(note).slice(0, 500) : null,
    createdAt: now(),
  };

  const result = await withTransaction(async (c) => {
    const b = await loadBooking(pre.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    await insertEvidence(c, entry);
    await touchBooking(c, b.id);
    const counts = await evidenceCounts(c, b.id, phase);
    return { entry, counts, met: evidenceMet(counts, phase), rule: EVIDENCE_RULES[phase] };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.status(201).json({ ok: true, evidence: result.entry, counts: result.counts, requirement: result.rule, requirementMet: result.met });
}

/**
 * POST /api/bookings/:id/ready   (Pro only)
 * "Provider confirms ready to begin." Requires the mandatory pre-job evidence
 * (≥2 photos + 1 video). funded → awaiting_material_approval.
 */
export async function readyToStart(req, res) {
  const result = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (!isAssignedPro(req, b)) return { code: 403, error: 'Only the assigned professional can do this.' };
    if (b.kind !== 'quote') return { code: 409, error: 'Only quote jobs use this step.' };
    if (b.status !== BOOKING_STATUS.FUNDED) return { code: 409, error: `Can't confirm ready from status "${b.status}".` };
    const counts = await evidenceCounts(c, b.id, 'pre_job');
    if (!evidenceMet(counts, 'pre_job')) {
      const r = EVIDENCE_RULES.pre_job;
      return { code: 422, error: `Upload at least ${r.minPhotos} photos and ${r.minVideos} video of the site before starting (have ${counts.photos} photos, ${counts.videos} video).` };
    }
    await transitionBooking(c, b.id, BOOKING_STATUS.AWAITING_MATERIAL_APPROVAL, {
      actor: 'pro', note: 'Pre-job evidence uploaded; ready to begin — awaiting material-cost approval',
      set: { readyAt: now() },
    });
    return { bookingId: b.id, message: 'Ready confirmed. Waiting for the customer to approve the material cost.' };
  });
  return respond(res, result);
}

/**
 * POST /api/bookings/:id/approve-materials   (Customer)
 * The customer explicitly approves releasing the material cost. On success the
 * materials (+ net inspection) are transferred to the pro and the job moves to
 * in_progress. Labour stays held. Retryable if the transfer can't run yet.
 */
export async function approveMaterials(req, res) {
  const b = await loadBooking(req.params.id);
  if (!b) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  if (b.kind !== 'quote') return res.status(409).json({ ok: false, error: 'Only quote jobs use this step.' });
  if (b.status !== BOOKING_STATUS.AWAITING_MATERIAL_APPROVAL) {
    return res.status(409).json({ ok: false, error: `This job isn't awaiting material approval (status: ${b.status}).` });
  }
  const tx = await findBookingTx(b.id, [TX_STATUS.IN_ESCROW]);
  if (!tx) return res.status(409).json({ ok: false, error: 'No funds are held in escrow for this job.' });

  const out = await releaseMaterials(tx.reference, 'customer');
  if (!out.ok) return res.status(out.code || 502).json({ ok: false, error: out.error });

  res.json({
    ok: true, booking: await loadBooking(b.id), released: true, stage: 'materials', payoutKobo: out.payoutKobo,
    message: 'Material cost approved and released to the professional. Labour stays protected until the job is done.',
  });
}

/**
 * POST /api/bookings/:id/complete   (Pro only)
 * Simple booking: (funded|in_progress) → awaiting_confirmation.
 * Quote booking: in_progress → awaiting_completion_review (needs completion
 *   evidence); redo_in_progress → awaiting_redo_review (needs redo evidence).
 */
export async function completeJob(req, res) {
  const result = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (!isAssignedPro(req, b)) return { code: 403, error: 'Only the assigned professional can mark this job complete.' };

    if (b.kind === 'quote') {
      let phase, next;
      if (b.status === BOOKING_STATUS.IN_PROGRESS) { phase = 'completion'; next = BOOKING_STATUS.AWAITING_COMPLETION_REVIEW; }
      else if (b.status === BOOKING_STATUS.REDO_IN_PROGRESS) { phase = 'redo'; next = BOOKING_STATUS.AWAITING_REDO_REVIEW; }
      else return { code: 409, error: `Can't complete a quote job from status "${b.status}".` };

      const counts = await evidenceCounts(c, b.id, phase);
      if (!evidenceMet(counts, phase)) {
        const r = EVIDENCE_RULES[phase];
        return { code: 422, error: `Upload at least ${r.minPhotos} photos of the completed work first (have ${counts.photos}).` };
      }
      await transitionBooking(c, b.id, next, {
        actor: 'pro',
        note: phase === 'redo' ? 'Redo completed — awaiting customer review' : 'Work completed — awaiting customer review',
        set: { completedAt: now() },
      });
      return { bookingId: b.id, message: 'Marked complete. Awaiting customer review.' };
    }

    // Simple booking (legacy single-amount flow).
    if (![BOOKING_STATUS.FUNDED, BOOKING_STATUS.IN_PROGRESS].includes(b.status)) {
      return { code: 409, error: `Can't complete a job from status "${b.status}".` };
    }
    await transitionBooking(c, b.id, BOOKING_STATUS.AWAITING_CONFIRMATION, {
      actor: 'pro', note: 'Marked complete — awaiting customer confirmation',
      set: { completedAt: now(), disputeEligibleAt: new Date(Date.now() + DISPUTE_WINDOW_MS).toISOString() },
    });
    return { bookingId: b.id, message: 'Marked complete. Awaiting customer confirmation.' };
  });
  return respond(res, result);
}

/**
 * POST /api/bookings/:id/confirm-completion   (Customer) — QUOTE bookings.
 * The customer is satisfied. Releases the held labour to the pro and closes the
 * job (completed). Valid from awaiting_completion_review or awaiting_redo_review.
 */
export async function confirmCompletion(req, res) {
  const b = await loadBooking(req.params.id);
  if (!b) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  if (b.kind !== 'quote') return res.status(409).json({ ok: false, error: 'Only quote jobs use this step.' });
  if (![BOOKING_STATUS.AWAITING_COMPLETION_REVIEW, BOOKING_STATUS.AWAITING_REDO_REVIEW].includes(b.status)) {
    return res.status(409).json({ ok: false, error: `This job isn't awaiting your review (status: ${b.status}).` });
  }
  const tx = await findBookingTx(b.id, HELD);
  if (!tx) return res.status(409).json({ ok: false, error: 'No labour funds are held for this job.' });

  const out = await releaseLabour(tx.reference, 'customer');
  if (!out.ok) return res.status(out.code || 502).json({ ok: false, error: out.error });

  res.json({
    ok: true, booking: await loadBooking(b.id), released: true, stage: 'labour', payoutKobo: out.payoutKobo,
    message: 'Job completed. The labour fee has been released to the professional. Thank you!',
  });
}

/**
 * POST /api/bookings/:id/request-redo   (Customer) — QUOTE bookings.
 * The customer isn't satisfied and uses the ONE allowed redo.
 * awaiting_completion_review → redo_in_progress.
 */
export async function requestRedo(req, res) {
  const { reason } = req.body || {};
  const result = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (b.kind !== 'quote') return { code: 409, error: 'Only quote jobs use this step.' };
    if (b.status === BOOKING_STATUS.AWAITING_REDO_REVIEW) {
      return { code: 409, error: 'The redo has already been used. Escalate to Servora Support instead.' };
    }
    if (b.status !== BOOKING_STATUS.AWAITING_COMPLETION_REVIEW) {
      return { code: 409, error: `A redo can only be requested while reviewing the completed work (status: ${b.status}).` };
    }
    if ((b.redoCount || 0) >= 1) return { code: 409, error: 'Only one redo is allowed. Escalate to Servora Support instead.' };
    const redoReason = reason ? String(reason).slice(0, 500) : null;
    await transitionBooking(c, b.id, BOOKING_STATUS.REDO_IN_PROGRESS, {
      actor: 'customer', note: redoReason ? `Redo requested: ${redoReason}` : 'Redo requested',
      set: { redoCount: (b.redoCount || 0) + 1, redoReason },
    });
    return { bookingId: b.id, message: 'Redo requested. The professional will perfect the work and re-submit.' };
  });
  return respond(res, result);
}

/** Build a dispute record for a booking (shared by both escalation paths). */
const newDispute = (b, tx, { kind, openedBy, reason, amountKobo }) => ({
  id: 'dsp_' + randomUUID().slice(0, 12),
  bookingId: b.id,
  transactionId: tx?.id || null,
  reference: tx?.reference || null,
  amountKobo,
  service: b.service,
  kind,
  openedBy,
  reason,
  status: 'open',
  createdAt: now(),
});

/**
 * POST /api/bookings/:id/escalate   (Customer) — QUOTE bookings.
 * Still not satisfied after the redo → hand it to Servora Support to review the
 * evidence and make the final decision. awaiting_redo_review → disputed.
 * Labour stays held in escrow.
 */
export async function escalateDispute(req, res) {
  const { reason } = req.body || {};
  const result = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (b.kind !== 'quote') return { code: 409, error: 'Only quote jobs use this step.' };
    if (b.status !== BOOKING_STATUS.AWAITING_REDO_REVIEW) {
      return { code: 409, error: `You can escalate to Support only after reviewing the redo (status: ${b.status}).` };
    }
    const tx = await findBookingTx(b.id, HELD, c);
    const dispute = newDispute(b, tx, {
      kind: 'quote', openedBy: 'customer',
      reason: reason ? String(reason).slice(0, 500) : 'Customer not satisfied after the redo.',
      // For split jobs the disputed amount is the still-held labour.
      amountKobo: tx?.split ? tx.split.labourKobo : (tx?.amountKobo ?? b.agreedAmountKobo ?? null),
    });
    if (!await insertDispute(c, dispute)) return { code: 409, error: 'This job already has an open dispute.' };
    await transitionBooking(c, b.id, BOOKING_STATUS.DISPUTED,
      { actor: 'customer', note: 'Escalated to Servora Support after redo', set: { disputedAt: now() } });
    if (tx) await recordEvent(c, tx, { type: 'dispute_opened', actor: 'customer', data: { disputeId: dispute.id, reason: dispute.reason } });
    return { bookingId: b.id, disputeId: dispute.id };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.status(201).json({
    ok: true, booking: await loadBooking(result.bookingId), dispute: await getDispute(result.disputeId),
    message: 'Escalated. Servora Support will review the evidence and make a final decision. The labour fee stays held.',
  });
}

/**
 * POST /api/bookings/:id/confirm   (Customer) — SIMPLE bookings (legacy).
 * Confirms satisfactory completion and AUTO-RELEASES the single escrow amount.
 */
export async function confirmBooking(req, res) {
  const step = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (b.kind === 'quote') return { code: 409, error: 'Quote jobs are confirmed via /confirm-completion.' };
    if (b.status !== BOOKING_STATUS.AWAITING_CONFIRMATION) {
      return { code: 409, error: `This job isn't awaiting your confirmation yet (status: ${b.status}).` };
    }
    await transitionBooking(c, b.id, BOOKING_STATUS.CONFIRMED, { actor: 'customer', note: 'Customer confirmed completion' });
    const tx = await findBookingTx(b.id, [TX_STATUS.IN_ESCROW], c);
    return { bookingId: b.id, reference: tx?.reference || null };
  });
  if (step.error) return res.status(step.code).json({ ok: false, error: step.error });

  // Auto-release on confirmation.
  let release = null;
  if (step.reference) release = await releaseEscrow(step.reference, 'customer');

  res.json({
    ok: true,
    booking: await loadBooking(step.bookingId),
    released: Boolean(release?.ok),
    releaseStatus: release?.status || null,
    message: release?.ok
      ? 'Confirmed. Your payment is being released to the professional.'
      : 'Confirmed. Your payment will be released to the professional shortly.',
  });
}

/**
 * POST /api/bookings/:id/dispute   (Pro only) — SIMPLE bookings (legacy).
 * If the customer goes silent, the pro can escalate 24h after marking complete:
 * awaiting_confirmation → disputed. Funds stay held; Servora Support reviews.
 */
export async function openDispute(req, res) {
  const { reason } = req.body || {};
  const result = await withTransaction(async (c) => {
    const b = await loadBooking(req.params.id, c, { forUpdate: true });
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (!isAssignedPro(req, b)) return { code: 403, error: 'Only the assigned professional can open a dispute.' };
    if (b.status !== BOOKING_STATUS.AWAITING_CONFIRMATION) {
      return { code: 409, error: `A dispute can only be opened while awaiting customer confirmation (status: ${b.status}).` };
    }
    if (!b.disputeEligibleAt || Date.now() < new Date(b.disputeEligibleAt).getTime()) {
      const hrs = Math.max(1, Math.ceil((new Date(b.disputeEligibleAt).getTime() - Date.now()) / 3600000));
      return { code: 409, error: `You can open a dispute 24 hours after marking the job complete. Try again in ~${hrs}h.` };
    }
    const tx = await findBookingTx(b.id, [TX_STATUS.IN_ESCROW], c);
    const dispute = newDispute(b, tx, {
      kind: 'simple', openedBy: 'pro',
      reason: reason ? String(reason).slice(0, 500) : 'Customer did not confirm within 24 hours.',
      amountKobo: tx?.amountKobo ?? b.agreedAmountKobo ?? null,
    });
    if (!await insertDispute(c, dispute)) return { code: 409, error: 'This job already has an open dispute.' };
    await transitionBooking(c, b.id, BOOKING_STATUS.DISPUTED,
      { actor: 'pro', note: 'Pro escalated — customer did not confirm within 24h', set: { disputedAt: now() } });
    if (tx) await recordEvent(c, tx, { type: 'dispute_opened', actor: 'pro', data: { disputeId: dispute.id, reason: dispute.reason } });
    return { bookingId: b.id, disputeId: dispute.id };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.status(201).json({
    ok: true,
    booking: await loadBooking(result.bookingId),
    dispute: await getDispute(result.disputeId),
    message: 'Dispute opened. Servora Support will review and may request evidence. Funds remain held in escrow.',
  });
}
