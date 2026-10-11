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
import { withTransaction } from '../db/pool.js';
import { readKycImage } from '../store/kycStore.js';
import { listProsForKyc, getProWithKyc, updatePro, recordKycDecision } from '../store/professionals.js';
import { isUuid } from '../store/util.js';
import { isAdmin } from '../middleware/adminAuth.js';

// The router already enforces requireAdmin; this second check is defence in
// depth so a handler re-mounted elsewhere can never serve KYC data unguarded.
const adminOk = (req) => isAdmin(req);

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
    autoOutcome: p.idVerification.autoOutcome ?? null,   // provider's original verdict
    confidence: p.idVerification.confidence,
    match: p.idVerification.match,
    reasons: p.idVerification.reasons || [],
    checks: p.idVerification.checks || {},
    checkedAt: p.idVerification.checkedAt,
    error: p.idVerification.error ?? null,
    // Full audit trail for disputes — admin-only, never in a public response.
    raw: p.idVerification.raw ?? null,
    endpoint: p.idVerification.endpoint ?? null,
    environment: p.idVerification.environment ?? null,
    thresholdUsed: p.idVerification.thresholdUsed ?? null,
    httpStatus: p.idVerification.httpStatus ?? null,
    decidedBy: p.idVerification.decidedBy ?? null,
    decidedAt: p.idVerification.decidedAt ?? null,
    decisionReason: p.idVerification.decisionReason ?? null,
  } : null,
  hasImages: { idDocument: Boolean(p.kycMedia?.idDocument), selfie: Boolean(p.kycMedia?.selfie) },
});

/** GET /api/admin/kyc?status=pending_review|verified|rejected|all */
export async function listKycQueue(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const status = String(req.query.status || 'pending_review');
  const pros = await listProsForKyc(status);
  res.json({ ok: true, count: pros.length, status, pros: pros.map(reviewPro) });
}

/** GET /api/admin/kyc/:id */
export async function getKycPro(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const pro = await getProWithKyc(req.params.id);
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });
  res.json({ ok: true, pro: reviewPro(pro) });
}

/**
 * GET /api/admin/kyc/:id/image/:kind   (kind = idDocument | selfie)
 * Streams the stored KYC image to an authenticated reviewer. This is the ONLY
 * way these files can be read — they are not in any statically served folder.
 */
export async function getKycImage(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const { id, kind } = req.params;
  if (!['idDocument', 'selfie'].includes(kind)) {
    return res.status(400).json({ ok: false, error: "kind must be 'idDocument' or 'selfie'." });
  }
  const pro = await getProWithKyc(id);
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

  if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'Professional not found.' });
  const result = await withTransaction(async (c) => {
    // Lock the row: two reviewers deciding at once must not both win.
    const { rows } = await c.query('SELECT id FROM professionals WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) return { code: 404, error: 'Professional not found.' };
    const p = await getProWithKyc(rows[0].id, c);
    if (p.status === 'verified' && p.idVerified === true) {
      return { code: 409, error: 'This professional is already verified.' };
    }
    const approved = decision === 'approve';
    await updatePro(p.id, {
      status: approved ? 'verified' : 'rejected',
      idVerified: approved,
      // Badge is granted only alongside idVerified — never left dangling.
      badges: approved
        ? Array.from(new Set([...(p.badges || []), 'v']))
        : (p.badges || []).filter((b) => b !== 'v'),
    }, c);
    if (p.idVerification) {
      await recordKycDecision(c, p.idVerification.id, {
        outcome: approved ? 'manually_approved' : 'manually_rejected',
        // Preserve what the provider originally said — a manual decision must
        // never erase the automated verdict it overrode.
        autoOutcome: p.idVerification.autoOutcome ?? p.idVerification.outcome ?? null,
        decidedBy: 'admin',
        decisionReason: reason ? String(reason).slice(0, 500) : null,
      });
    }
    return { id: p.id };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });

  res.json({
    ok: true,
    decision,
    pro: reviewPro(await getProWithKyc(result.id)),
    message: decision === 'approve'
      ? 'Professional approved — ID Verified badge granted and profile is now live.'
      : 'Professional rejected — profile stays hidden and no badge is shown.',
  });
}
