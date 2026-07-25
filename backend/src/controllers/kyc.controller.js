/**
 * KYC admin review — the manual queue for professionals whose automated
 * ID+selfie check did not cleanly pass.
 *
 * Every route here is gated by ADMIN_API_KEY (x-admin-key header), including
 * the image endpoint: government IDs and selfies are never publicly reachable.
 *
 *   GET  /api/admin/kyc            queue (default: pending_review)
 *   GET  /api/admin/kyc/:id        one pro's full verification record
 *   GET  /api/admin/kyc/:id/image/:kind   idDocument | selfie  (binary)
 *   POST /api/admin/kyc/:id/decision      { decision: 'approve'|'reject', reason? }
 */
import { loadDB, mutate } from '../store/store.js';
import { readKycImage } from '../store/kycStore.js';
import { ADMIN_API_KEY } from '../config.js';

const now = () => new Date().toISOString();
const adminOk = (req) => Boolean(ADMIN_API_KEY) && req.headers['x-admin-key'] === ADMIN_API_KEY;

/** Reviewer-facing view of a pro — contact details included (needed to follow up),
 *  but never the password hash or the raw provider payload. */
const reviewPro = (p) => ({
  id: p.id,
  name: p.name,
  phone: p.phone,
  email: p.email,
  category: p.category,
  state: p.state,
  lga: p.lga,
  status: p.status,
  createdAt: p.createdAt,
  idVerified: p.idVerified === true,
  idDocument: p.idDocument ? { type: p.idDocument.type, fileName: p.idDocument.fileName ?? null } : null,
  idVerification: p.idVerification ? {
    provider: p.idVerification.provider,
    outcome: p.idVerification.outcome,
    confidence: p.idVerification.confidence,
    match: p.idVerification.match,
    reasons: p.idVerification.reasons || [],
    checks: p.idVerification.checks || {},
    checkedAt: p.idVerification.checkedAt,
    decidedBy: p.idVerification.decidedBy ?? null,
    decidedAt: p.idVerification.decidedAt ?? null,
    decisionReason: p.idVerification.decisionReason ?? null,
  } : null,
  hasImages: { idDocument: Boolean(p.kycMedia?.idDocument), selfie: Boolean(p.kycMedia?.selfie) },
});

/** GET /api/admin/kyc?status=pending_review|verified|rejected|all */
export function listKycQueue(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const status = req.query.status || 'pending_review';
  const pros = loadDB().professionals
    .filter((p) => (status === 'all' ? Boolean(p.idVerification) : p.status === status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, count: pros.length, status, pros: pros.map(reviewPro) });
}

/** GET /api/admin/kyc/:id */
export function getKycPro(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const pro = loadDB().professionals.find((p) => String(p.id) === String(req.params.id));
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });
  res.json({ ok: true, pro: reviewPro(pro) });
}

/**
 * GET /api/admin/kyc/:id/image/:kind   (kind = idDocument | selfie)
 * Streams the stored KYC image to an authenticated reviewer. This is the ONLY
 * way these files can be read — they are not in any statically served folder.
 */
export function getKycImage(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const { id, kind } = req.params;
  if (!['idDocument', 'selfie'].includes(kind)) {
    return res.status(400).json({ ok: false, error: "kind must be 'idDocument' or 'selfie'." });
  }
  const pro = loadDB().professionals.find((p) => String(p.id) === String(id));
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });

  const file = pro.kycMedia?.[kind];
  if (!file) return res.status(404).json({ ok: false, error: 'No image on file.' });
  const img = readKycImage(file);
  if (!img) return res.status(404).json({ ok: false, error: 'Image is no longer available.' });

  res.set('Content-Type', img.mime);
  res.set('Cache-Control', 'no-store, private');   // never cached by proxies
  res.send(img.buffer);
}

/**
 * POST /api/admin/kyc/:id/decision
 * Body: { decision: 'approve' | 'reject', reason? }
 * approve → status 'verified' + idVerified true (badge granted by a human)
 * reject  → status 'rejected', badge never granted, pro stays unlisted
 */
export async function decideKyc(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const { decision, reason } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ ok: false, error: "decision must be 'approve' or 'reject'." });
  }

  const result = await mutate((db) => {
    const p = db.professionals.find((x) => String(x.id) === String(req.params.id));
    if (!p) return { code: 404, error: 'Professional not found.' };
    if (p.status === 'verified' && p.idVerified === true) {
      return { code: 409, error: 'This professional is already verified.' };
    }
    const approved = decision === 'approve';
    p.status = approved ? 'verified' : 'rejected';
    p.idVerified = approved;
    // Badge is granted only alongside idVerified — never left dangling.
    p.badges = approved
      ? Array.from(new Set([...(p.badges || []), 'v']))
      : (p.badges || []).filter((b) => b !== 'v');
    p.idVerification = {
      ...(p.idVerification || {}),
      outcome: approved ? 'manually_approved' : 'manually_rejected',
      decidedBy: 'admin',
      decidedAt: now(),
      decisionReason: reason ? String(reason).slice(0, 500) : null,
    };
    p.updatedAt = now();
    return { pro: p };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });

  res.json({
    ok: true,
    decision,
    pro: reviewPro(result.pro),
    message: decision === 'approve'
      ? 'Professional approved — ID Verified badge granted and profile is now live.'
      : 'Professional rejected — profile stays hidden and no badge is shown.',
  });
}
