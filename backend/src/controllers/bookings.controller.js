/**
 * Bookings controller — the agreed job between a customer and a pro.
 * A booking carries the authoritative price (agreedAmountKobo) that the
 * payment flow charges. Customers still need no account; a booking is just
 * the job + who it's for + the agreed amount.
 */
import { randomUUID } from 'node:crypto';
import { loadDB, mutate } from '../store/store.js';
import { BOOKING_STATUS, TX_STATUS, DISPUTE_WINDOW_MS, recordEvent } from '../services/escrow.js';
import { releaseEscrow } from '../services/escrowActions.js';

const now = () => new Date().toISOString();
const isPosInt = (n) => Number.isInteger(n) && n > 0;
const MIN_KOBO = 10000;          // ₦100 floor (sanity)
const MAX_KOBO = 500000000;      // ₦5,000,000 ceiling (sanity guard against fat-finger)

// A pro proves ownership of a booking with their demo bearer token.
const BEARER = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const escrowTxFor = (db, bookingId) =>
  db.transactions.find((t) => t.bookingId === bookingId && t.status === TX_STATUS.IN_ESCROW);

/**
 * POST /api/bookings
 * Body: { proId, service?, description?, amountNaira? | amountKobo?, customer:{ name?, email?, phone? } }
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

  const db = loadDB();
  const pro = db.professionals.find((p) => String(p.id) === String(proId) && p.status === 'verified');
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });

  if (!customer?.email && !customer?.phone) {
    return res.status(400).json({ ok: false, error: 'Customer email or phone is required.' });
  }

  const booking = {
    id: 'bk_' + randomUUID().slice(0, 12),
    proId: pro.id,
    service: service ?? pro.category,
    description: description ?? null,
    customer: {
      name: customer?.name ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    },
    agreedAmountKobo: kobo,
    status: BOOKING_STATUS.PENDING_PAYMENT,
    completedAt: null,
    autoConfirmAt: null,
    disputedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };

  await mutate((d) => d.bookings.push(booking));
  res.status(201).json({ ok: true, booking });
}

/** GET /api/bookings/:id */
export function getBooking(req, res) {
  const booking = loadDB().bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  res.json({ ok: true, booking });
}

/**
 * POST /api/bookings/:id/start   (Pro only)
 * The professional starts the job: funded → in_progress.
 */
export async function startJob(req, res) {
  const result = await mutate((db) => {
    const b = db.bookings.find((x) => x.id === req.params.id);
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (BEARER(req) !== 'demo-' + b.proId) return { code: 403, error: 'Only the assigned professional can start this job.' };
    if (b.status !== BOOKING_STATUS.FUNDED) return { code: 409, error: `Can't start a job from status "${b.status}".` };
    b.status = BOOKING_STATUS.IN_PROGRESS;
    b.startedAt = now();
    b.updatedAt = now();
    return { booking: b };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, booking: result.booking, message: 'Job started.' });
}

/**
 * POST /api/bookings/:id/complete   (Pro only)
 * The professional marks the job done: (funded|in_progress) → awaiting_confirmation.
 * Stamps completedAt and the 24h dispute-eligibility time.
 */
export async function completeJob(req, res) {
  const result = await mutate((db) => {
    const b = db.bookings.find((x) => x.id === req.params.id);
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (BEARER(req) !== 'demo-' + b.proId) return { code: 403, error: 'Only the assigned professional can mark this job complete.' };
    if (![BOOKING_STATUS.FUNDED, BOOKING_STATUS.IN_PROGRESS].includes(b.status)) {
      return { code: 409, error: `Can't complete a job from status "${b.status}".` };
    }
    b.status = BOOKING_STATUS.AWAITING_CONFIRMATION;
    b.completedAt = now();
    b.disputeEligibleAt = new Date(Date.now() + DISPUTE_WINDOW_MS).toISOString();
    b.updatedAt = now();
    return { booking: b };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, booking: result.booking, message: 'Marked complete. Awaiting customer confirmation.' });
}

/**
 * POST /api/bookings/:id/confirm   (Customer)
 * Customer confirms satisfactory completion. Only valid from
 * awaiting_confirmation. On confirm we AUTO-RELEASE the escrow to the pro
 * (commission retained). If release can't run yet (e.g. the pro hasn't added
 * a payout account), the booking stays confirmed and funds stay in escrow to
 * be released later.
 * NOTE (demo): the customer's capability is knowing the booking id; production
 * should use a signed, single-use confirm token sent to the customer.
 */
export async function confirmBooking(req, res) {
  const step = await mutate((db) => {
    const b = db.bookings.find((x) => x.id === req.params.id);
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (b.status !== BOOKING_STATUS.AWAITING_CONFIRMATION) {
      return { code: 409, error: `This job isn't awaiting your confirmation yet (status: ${b.status}).` };
    }
    b.status = BOOKING_STATUS.CONFIRMED;
    b.updatedAt = now();
    const tx = escrowTxFor(db, b.id);
    return { booking: b, reference: tx?.reference || null };
  });
  if (step.error) return res.status(step.code).json({ ok: false, error: step.error });

  // Auto-release on confirmation.
  let release = null;
  if (step.reference) release = await releaseEscrow(step.reference, 'customer');

  res.json({
    ok: true,
    booking: step.booking,
    released: Boolean(release?.ok),
    releaseStatus: release?.status || null,
    message: release?.ok
      ? 'Confirmed. Your payment is being released to the professional.'
      : 'Confirmed. Your payment will be released to the professional shortly.',
  });
}

/**
 * POST /api/bookings/:id/dispute   (Pro only)
 * If the customer goes silent, the pro can escalate 24h after marking the job
 * complete: awaiting_confirmation → disputed. Funds stay held; Servora Support
 * reviews. Creates a dispute record.
 */
export async function openDispute(req, res) {
  const { reason } = req.body || {};
  const result = await mutate((db) => {
    const b = db.bookings.find((x) => x.id === req.params.id);
    if (!b) return { code: 404, error: 'Booking not found.' };
    if (BEARER(req) !== 'demo-' + b.proId) return { code: 403, error: 'Only the assigned professional can open a dispute.' };
    if (b.status !== BOOKING_STATUS.AWAITING_CONFIRMATION) {
      return { code: 409, error: `A dispute can only be opened while awaiting customer confirmation (status: ${b.status}).` };
    }
    if (!b.disputeEligibleAt || Date.now() < new Date(b.disputeEligibleAt).getTime()) {
      const hrs = Math.max(1, Math.ceil((new Date(b.disputeEligibleAt).getTime() - Date.now()) / 3600000));
      return { code: 409, error: `You can open a dispute 24 hours after marking the job complete. Try again in ~${hrs}h.` };
    }
    const tx = escrowTxFor(db, b.id);
    b.status = BOOKING_STATUS.DISPUTED;
    b.disputedAt = now();
    b.updatedAt = now();
    const dispute = {
      id: 'dsp_' + randomUUID().slice(0, 12),
      bookingId: b.id,
      transactionId: tx?.id || null,
      reference: tx?.reference || null,
      amountKobo: tx?.amountKobo ?? b.agreedAmountKobo ?? null,
      service: b.service,
      openedBy: 'pro',
      reason: reason ? String(reason).slice(0, 500) : 'Customer did not confirm within 24 hours.',
      status: 'open',            // open → evidence_requested → resolved
      evidenceRequests: [],
      evidence: [],
      resolution: null,
      createdAt: now(),
      updatedAt: now(),
    };
    db.disputes.push(dispute);
    if (tx) recordEvent(db, tx, { type: 'dispute_opened', actor: 'pro', data: { disputeId: dispute.id, reason: dispute.reason } });
    return { booking: b, dispute };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.status(201).json({
    ok: true,
    booking: result.booking,
    dispute: result.dispute,
    message: 'Dispute opened. Servora Support will review and may request evidence. Funds remain held in escrow.',
  });
}
