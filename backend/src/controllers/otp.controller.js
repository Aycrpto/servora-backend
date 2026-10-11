/**
 * OTP endpoints for registration verification.
 *
 * SECURITY — no caller-supplied destinations. A resend takes only an otpId and
 * re-sends to the number/email already stored against that request. If the
 * endpoint accepted a phone number it would be an open SMS relay: anyone could
 * make us text arbitrary numbers and run up the Termii bill.
 *
 *   POST /api/otp/resend   { otpId }        → new code to the stored destination
 *   POST /api/otp/verify   { otpId, code }  → activates the pro on success
 *   GET  /api/otp/:id      status (no code, no full destination)
 */
import { requestOtp, verifyOtp, checkSendAllowance, maskDestination,
         MAX_SENDS_PER_HOUR } from '../services/otp.js';
import { getOtpRequest } from '../store/otpRequests.js';
import { updatePro } from '../store/professionals.js';

/** GET /api/otp/:id — lets the UI show masked destination + cooldown state. */
export async function getOtpStatus(req, res) {
  const r = await getOtpRequest(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Verification request not found.' });
  const allow = await checkSendAllowance(r.destination);
  res.json({
    ok: true,
    otpId: r.id,
    channel: r.channel,
    destinationMasked: maskDestination(r.channel, r.destination),
    verified: Boolean(r.verifiedAt),
    expiresAt: r.expiresAt,
    expired: !r.verifiedAt && Date.now() > new Date(r.expiresAt).getTime(),
    canResend: allow.allowed,
    resendInSec: allow.retryAfterSec,
    sendsUsed: (r.sends || []).length,
    maxSendsPerHour: MAX_SENDS_PER_HOUR,
  });
}

/** POST /api/otp/resend — { otpId } only. */
export async function resendOtp(req, res) {
  const { otpId } = req.body || {};
  if (!otpId) return res.status(400).json({ ok: false, error: 'otpId is required.' });

  const r = await getOtpRequest(otpId);
  if (!r) return res.status(404).json({ ok: false, error: 'Verification request not found.' });
  if (r.verifiedAt) return res.status(409).json({ ok: false, error: 'This number is already verified.' });

  // Destination comes from the stored record — never from the request body.
  const out = await requestOtp({
    subjectType: r.subjectType, subjectId: r.subjectId,
    channel: r.channel, destination: r.destination,
  });
  if (!out.ok) {
    if (out.retryAfterSec) res.set('Retry-After', String(out.retryAfterSec));
    return res.status(out.code || 502).json({ ok: false, error: out.error, retryAfterSec: out.retryAfterSec });
  }
  res.json({ ...out, message: `A new code was sent to ${out.destinationMasked}.` });
}

/**
 * POST /api/otp/verify — { otpId, code }
 * On success the professional becomes active: otpVerified flips true, which is
 * what the public listing endpoints gate on.
 */
export async function verifyOtpCode(req, res) {
  const { otpId, code } = req.body || {};
  if (!otpId) return res.status(400).json({ ok: false, error: 'otpId is required.' });

  const out = await verifyOtp({ otpId, code });
  if (!out.ok) return res.status(out.code || 400).json({ ok: false, error: out.error });

  const updated = await updatePro(out.subjectId, {
    otpVerified: true,
    otpVerifiedAt: new Date().toISOString(),
    contactVerification: { channel: out.channel || null },
  });
  if (!updated) return res.status(404).json({ ok: false, error: 'Account not found.' });

  // Live only when BOTH checks pass: contact verified here, ID verified by KYC.
  const live = updated.status === 'verified';
  res.json({
    ok: true,
    verified: true,
    otpVerified: true,
    live,
    status: updated.status,
    message: live
      ? 'Verified — your profile now appears in search.'
      : 'Phone verified. Your ID still needs a manual check before your profile can appear in search.',
  });
}
