/**
 * Registration OTP — 6-digit code sent to a phone (default) or email.
 *
 * SMS path uses Termii's MANAGED OTP API, so Termii generates, stores and
 * verifies the code — we never see or store it:
 *   send   POST {base}/api/sms/otp/send    -> { pinId, pin_id, smsStatus, status }
 *   verify POST {base}/api/sms/otp/verify  -> { pinId, verified: "True", msisdn }
 * Note `verified` comes back as the STRING "True", not a boolean.
 *
 * EMAIL path is deliberately different, and this is a documented deviation:
 * Termii's /api/email/otp/send is NOT a managed OTP — the caller supplies the
 * code, it returns no pin_id, and there is no matching verify endpoint, so
 * custom verification is unavoidable either way. It also needs an
 * email_configuration_id set up on their dashboard. We therefore generate the
 * code ourselves, store only a scrypt HASH of it, and deliver via Resend
 * (already used for quotes). Expiry, cooldown, cap and attempt rules are
 * identical across both channels.
 *
 * Abuse controls (SMS costs real money):
 *   • 10 minute expiry
 *   • 60 second cooldown between sends to the same destination
 *   • max 5 sends per rolling hour per destination
 *   • max 5 wrong guesses per request, then it's dead
 */
import { randomInt, randomUUID } from 'node:crypto';
import {
  findLiveOtp, sendsInLastHour as recentSends, ensureOtpRequest, recordOtpSendFailure,
  recordOtpSendSuccess, getOtpRequest, incrementOtpAttempts, markOtpVerified,
} from '../store/otpRequests.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { intlPhone } from './notifications.js';
import { sendEmail } from './email.js';

const TERMII_API_KEY = process.env.TERMII_API_KEY || '';
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || 'Servora';
const TERMII_BASE = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com';
const TERMII_CHANNEL = process.env.TERMII_CHANNEL || 'generic';   // 'generic' | 'dnd'

export const OTP_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_SENDS_PER_HOUR = 5;
export const MAX_VERIFY_ATTEMPTS = 5;
const OTP_LENGTH = 6;

const now = () => new Date().toISOString();
const ms = (iso) => new Date(iso).getTime();

/** Normalise a destination so rate limits can't be dodged by reformatting. */
export function normaliseDestination(channel, value) {
  if (channel === 'email') return String(value || '').trim().toLowerCase();
  return intlPhone(value) || '';
}

/* ---------------------------------------------------------------- providers */

/** Termii managed OTP send. Returns { ok, pinId } or { ok:false, error }. */
async function termiiSendToken(phoneIntl) {
  if (!TERMII_API_KEY) {
    // Fail loudly — never pretend a code went out, and never print one.
    console.error('[otp] NOT SENT: SMS delivery is not configured (set TERMII_API_KEY).');
    return { ok: false, error: 'SMS delivery is not configured' };
  }
  const body = {
    api_key: TERMII_API_KEY,
    message_type: 'NUMERIC',
    to: phoneIntl,
    from: TERMII_SENDER_ID,
    channel: TERMII_CHANNEL,
    pin_attempts: MAX_VERIFY_ATTEMPTS,
    pin_time_to_live: OTP_TTL_MINUTES,     // minutes, 0-60
    pin_length: OTP_LENGTH,
    pin_placeholder: '< 123456 >',
    message_text: 'Your Servora verification code is < 123456 >. It expires in 10 minutes.',
    pin_type: 'NUMERIC',
  };
  try {
    const r = await fetch(`${TERMII_BASE}/api/sms/otp/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    const pinId = data?.pinId || data?.pin_id || null;
    if (!r.ok || !pinId) return { ok: false, error: data?.message || `Termii ${r.status}` };
    return { ok: true, pinId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Termii managed OTP verify. `verified` is the string "True" on success. */
async function termiiVerifyToken(pinId, pin) {
  if (!TERMII_API_KEY) return { ok: false, error: 'SMS verification is not configured' };
  try {
    const r = await fetch(`${TERMII_BASE}/api/sms/otp/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TERMII_API_KEY, pin_id: pinId, pin: String(pin) }),
    });
    const data = await r.json().catch(() => null);
    const v = data?.verified;
    const verified = v === true || String(v).toLowerCase() === 'true';
    return { ok: true, verified, raw: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Email delivery of a self-generated code (see module note). */
async function sendCodeByEmail(email, code) {
  const subject = `Your Servora verification code: ${code}`;
  const text = [
    `Your Servora verification code is ${code}.`,
    ``,
    `It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, ignore this email.`,
  ].join('\n');
  // services/email.js fails (and says so in the log) when email isn't
  // configured; the code itself is never logged.
  try {
    await sendEmail({ to: email, subject, text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------ rate limiting */

/**
 * { allowed, retryAfterSec, reason } — the shared cooldown + hourly cap.
 * Counts every send to the destination in the last hour across ALL requests,
 * so starting a new request can't reset the counter.
 */
export async function checkSendAllowance(destination) {
  const sends = await recentSends(destination);
  if (sends.length >= MAX_SENDS_PER_HOUR) {
    const oldest = ms(sends[sends.length - 1]);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + 3600_000 - Date.now()) / 1000)),
      reason: `Too many codes requested. Try again later.` };
  }
  if (sends.length) {
    const since = Date.now() - ms(sends[0]);
    if (since < RESEND_COOLDOWN_MS) {
      return { allowed: false, retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - since) / 1000),
        reason: 'Please wait before requesting another code.' };
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

/* ------------------------------------------------------------------- public */

/**
 * Create-or-resend an OTP for a subject. Returns
 * { ok, otpId, channel, destinationMasked, expiresAt, resendAvailableIn } or
 * { ok:false, code, error, retryAfterSec }.
 */
export async function requestOtp({ subjectType = 'pro', subjectId, channel, destination }) {
  const chan = channel === 'email' ? 'email' : 'sms';
  const dest = normaliseDestination(chan, destination);
  if (!dest) return { ok: false, code: 400, error: chan === 'email' ? 'A valid email is required.' : 'A valid phone number is required.' };

  // Reuse the live request for this subject+destination so resends extend one
  // record rather than creating a fresh one each time.
  const existing = await findLiveOtp(subjectId, dest);

  const allow = await checkSendAllowance(dest);
  if (!allow.allowed) {
    // Still hand back the live otpId: a code they already received is usable,
    // so being inside the cooldown must not leave them with nothing to enter.
    return { ok: false, code: 429, error: allow.reason, retryAfterSec: allow.retryAfterSec,
      otpId: existing?.id || null,
      channel: existing?.channel || chan,
      destinationMasked: maskDestination(chan, dest),
      expiresAt: existing?.expiresAt || null };
  }

  /**
   * Create the record BEFORE attempting delivery. Previously a failed send
   * returned early and persisted nothing, so the caller got no otpId — the
   * account existed but there was no request to resend against, stranding the
   * user with "register again" on a number that was already taken.
   */
  // (subjectType is always 'pro' today; the table keys requests by pro id.)
  const record = existing || await ensureOtpRequest({
    id: 'otp_' + randomUUID().slice(0, 12), proId: subjectId, channel: chan,
    destination: dest, provider: chan === 'sms' ? 'termii' : 'resend',
  });

  let pinId = null, codeHash = null, sendError = null;
  if (chan === 'sms') {
    const sent = await termiiSendToken(dest);
    if (sent.ok) pinId = sent.pinId;
    else sendError = sent.error || 'send failed';
  } else {
    const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
    const sent = await sendCodeByEmail(dest, code);
    if (sent.ok) codeHash = await hashPassword(code);   // only the hash is ever stored
    else sendError = sent.error || 'send failed';
  }

  // Nothing reached the user: keep the record so they can retry, but do NOT
  // consume their hourly allowance and do NOT invalidate any earlier code that
  // may still be sitting in their inbox.
  if (sendError) {
    await recordOtpSendFailure(record.id, sendError);
    console.error(`[otp] send failed for ${maskDestination(chan, dest)} via ${chan}: ${sendError}`);
    return { ok: false, code: 502, otpId: record.id, providerError: sendError,
      error: 'We could not send your code right now. Please try “Resend code”.' };
  }

  // Delivered — now the new code becomes the only valid one.
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();
  // Only successful sends count toward the cap.
  await recordOtpSendSuccess(record.id, { pinId, codeHash, expiresAt, destination: dest });
  record.sends = [...(record.sends || []), now()];

  return {
    ok: true, otpId: record.id, channel: chan,
    destinationMasked: maskDestination(chan, dest),
    expiresAt, sendsUsed: record.sends.length, maxSendsPerHour: MAX_SENDS_PER_HOUR,
    resendAvailableInSec: Math.ceil(RESEND_COOLDOWN_MS / 1000),
  };
}

/** Verify a submitted code. Returns { ok, subjectId } or { ok:false, code, error }. */
export async function verifyOtp({ otpId, code }) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== OTP_LENGTH) return { ok: false, code: 400, error: `Enter the ${OTP_LENGTH}-digit code.` };

  const rec = await getOtpRequest(otpId);
  if (!rec) return { ok: false, code: 404, error: 'That verification request no longer exists.' };
  if (rec.verifiedAt) return { ok: true, subjectId: rec.subjectId, alreadyVerified: true };
  // No expiry means no code was ever successfully delivered — say that plainly
  // rather than claiming a code "expired" that the user never received.
  if (!rec.expiresAt) return { ok: false, code: 409, error: 'No code has been sent yet. Tap “Resend code”.' };
  if (Date.now() > ms(rec.expiresAt)) return { ok: false, code: 410, error: 'That code has expired. Request a new one.' };
  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, code: 429, error: 'Too many incorrect attempts. Request a new code.' };
  }

  let good = false;
  if (rec.channel === 'sms') {
    if (!rec.pinId) {
      // No provider configured (local/dev): accept nothing rather than
      // silently letting any code through.
      return { ok: false, code: 503, error: 'SMS verification is not configured on this server.' };
    }
    const res = await termiiVerifyToken(rec.pinId, clean);
    if (!res.ok) return { ok: false, code: 502, error: 'Could not check the code. Try again shortly.' };
    good = res.verified === true;
  } else {
    good = rec.codeHash ? await verifyPassword(clean, rec.codeHash) : false;
  }

  if (!good) {
    await incrementOtpAttempts(otpId);
    const left = Math.max(0, MAX_VERIFY_ATTEMPTS - (rec.attempts + 1));
    return { ok: false, code: 401, error: left ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new one.' };
  }

  await markOtpVerified(otpId);   // code is spent
  return { ok: true, subjectId: rec.subjectId, channel: rec.channel, destination: rec.destination };
}

/** "0803***4567" / "a***o@example.com" — enough to recognise, not to leak. */
export function maskDestination(channel, dest) {
  const s = String(dest || '');
  if (channel === 'email') {
    const [u, d] = s.split('@');
    if (!d) return s;
    return `${u.slice(0, 1)}${'*'.repeat(Math.max(1, u.length - 2))}${u.slice(-1)}@${d}`;
  }
  return s.length > 6 ? `${s.slice(0, 5)}${'*'.repeat(s.length - 8)}${s.slice(-3)}` : s;
}
