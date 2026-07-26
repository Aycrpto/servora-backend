/**
 * Disputes controller — Servora Support review workflow.
 *
 * A dispute is opened by a pro when a customer goes silent (see bookings
 * controller). Support (admin, x-admin-key) can request evidence and resolve;
 * the customer (capability = dispute id) can submit evidence. Funds stay held
 * in escrow throughout — resolution either releases to the pro or refunds the
 * customer, reusing the shared escrow-actions service.
 */
import { loadDB, mutate } from '../store/store.js';
import { persistPortfolio } from '../store/uploads.js';
import { isAdmin } from '../middleware/adminAuth.js';
import { TX_STATUS } from '../services/escrow.js';
import { releaseEscrow, releaseLabour, refundEscrow } from '../services/escrowActions.js';

const now = () => new Date().toISOString();
const adminOk = (req) => isAdmin(req);   // constant-time compare, see adminAuth.js

/** GET /api/disputes?status=   (Support) — the review queue. */
export function listDisputes(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const { status } = req.query;
  const disputes = loadDB().disputes
    .filter((d) => !status || d.status === status)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, count: disputes.length, disputes });
}

/** GET /api/disputes/:id   (capability by id — pro/customer/support can view). */
export function getDispute(req, res) {
  const dispute = loadDB().disputes.find((d) => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ ok: false, error: 'Dispute not found.' });
  res.json({ ok: true, dispute });
}

/** POST /api/disputes/:id/request-evidence   (Support) */
export async function requestEvidence(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const { note } = req.body || {};
  const result = await mutate((db) => {
    const d = db.disputes.find((x) => x.id === req.params.id);
    if (!d) return { code: 404, error: 'Dispute not found.' };
    if (d.status === 'resolved') return { code: 409, error: 'Dispute already resolved.' };
    d.evidenceRequests.push({ note: note ? String(note).slice(0, 500) : 'Please provide photos and a short description of the completed job.', at: now() });
    d.status = 'evidence_requested';
    d.updatedAt = now();
    return { dispute: d };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, dispute: result.dispute });
}

/** POST /api/disputes/:id/evidence   (Customer capability)
 *  Body: { text?, photos?[] }  — photos are data URLs written to /uploads. */
export async function submitEvidence(req, res) {
  const { text, photos } = req.body || {};
  if (!text?.toString().trim() && !(Array.isArray(photos) && photos.length)) {
    return res.status(400).json({ ok: false, error: 'Add a description or at least one photo.' });
  }
  const storedPhotos = persistPortfolio(photos); // reuse the upload pipeline (max 5)
  const result = await mutate((db) => {
    const d = db.disputes.find((x) => x.id === req.params.id);
    if (!d) return { code: 404, error: 'Dispute not found.' };
    if (d.status === 'resolved') return { code: 409, error: 'Dispute already resolved.' };
    d.evidence.push({ text: text ? String(text).slice(0, 1000) : null, photos: storedPhotos, at: now() });
    d.updatedAt = now();
    return { dispute: d };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, dispute: result.dispute, message: 'Evidence submitted. Servora Support will review.' });
}

/**
 * POST /api/disputes/:id/resolve   (Support)
 * Body: { decision: 'release_to_pro' | 'refund_customer', reason? }
 * Moves the money accordingly (reusing releaseEscrow / refundEscrow) and marks
 * the dispute resolved. Money is only touched here, at the very end.
 */
export async function resolveDispute(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const { decision, reason } = req.body || {};
  if (!['release_to_pro', 'refund_customer'].includes(decision)) {
    return res.status(400).json({ ok: false, error: "decision must be 'release_to_pro' or 'refund_customer'." });
  }

  const db0 = loadDB();
  const dispute = db0.disputes.find((d) => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ ok: false, error: 'Dispute not found.' });
  if (dispute.status === 'resolved') return res.status(409).json({ ok: false, error: 'Dispute already resolved.' });
  if (!dispute.reference) return res.status(409).json({ ok: false, error: 'Dispute has no linked transaction.' });

  // Split (quote) disputes escalate with only the labour still held, so releasing
  // to the pro means releasing that labour stage; refunds are handled partially
  // inside refundEscrow. Simple disputes release the single escrow amount.
  const tx = db0.transactions.find((t) => t.reference === dispute.reference);
  const isSplit = Boolean(tx?.split) || tx?.status === TX_STATUS.PARTIALLY_RELEASED;

  let outcome;
  if (decision === 'release_to_pro') {
    // Release straight from 'disputed' (bypass the confirmed-gate). The booking
    // only advances on a successful transfer, so a failed payout leaves the
    // dispute open and retryable — no half-resolved state.
    outcome = isSplit
      ? await releaseLabour(dispute.reference, 'support')
      : await releaseEscrow(dispute.reference, 'support', { requireConfirmed: false });
  } else {
    outcome = await refundEscrow(dispute.reference, { reason: reason || 'Dispute resolved in customer favour', actor: 'support' });
  }
  if (!outcome.ok) return res.status(outcome.code || 502).json({ ok: false, error: outcome.error });

  await mutate((db) => {
    const d = db.disputes.find((x) => x.id === req.params.id);
    if (d) {
      d.status = 'resolved';
      d.resolution = { decision, reason: reason || null, by: 'support', at: now() };
      d.updatedAt = now();
    }
  });
  res.json({
    ok: true,
    decision,
    outcome,
    message: decision === 'release_to_pro'
      ? 'Dispute resolved — funds released to the professional.'
      : 'Dispute resolved — customer refunded.',
  });
}
