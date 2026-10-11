/**
 * Auth controller — professional sign-in, sign-out and "who am I".
 *
 * A pro signs in with their registered WhatsApp number (any format:
 * 0803…, +234 803…, spaces/dashes ignored) or email, plus their own password
 * (scrypt hash; there is no shared or fallback password). Success returns an
 * opaque session token — see store/sessions.js — sent back as
 * `Authorization: Bearer <token>` on every pro-only request.
 *
 * Enumeration resistance: "no such account" and "wrong password" get the same
 * response, and both run exactly one scrypt verification, so neither the
 * message nor the response time reveals whether an account exists.
 */
import { randomBytes } from 'node:crypto';
import { findVerifiedForLogin, updatePro } from '../store/professionals.js';
import { createSession, revokeSession } from '../store/sessions.js';
import { verifyPassword, needsRehash, hashPassword } from '../services/passwords.js';
import { passesOtpGate } from '../config.js';
import { requestOtp } from '../services/otp.js';
import { bearerToken } from '../middleware/proAuth.js';

/** Compare phone numbers by their last 10 digits (0803… === +234803…). */
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);

const LOGIN_FAILED = 'That phone number or email and password don’t match a verified professional account.';

// Verified against when there is no account (or no password), so a miss costs
// the same scrypt work as a real check. Same cost parameters as real hashes.
const dummyHash = hashPassword(randomBytes(16).toString('hex'));

/*
 * Per-account lockout, on top of the per-IP limit on the route: after 10
 * failures for one phone/email in 15 minutes, that account is locked for the
 * rest of the window — so spreading guesses across many IPs doesn't help.
 * In memory (one instance); a restart clears it.
 */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map();   // key -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
}, 60_000).unref();

const lockedOut = (key) => {
  const f = failures.get(key);
  return f && f.resetAt > Date.now() && f.count >= MAX_FAILS ? Math.ceil((f.resetAt - Date.now()) / 1000) : 0;
};
const recordFailure = (key) => {
  const f = failures.get(key);
  if (!f || f.resetAt <= Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
  else f.count += 1;
};

/** The profile fields the dashboard shows and lets the pro edit — never credentials or documents. */
export const dashboardPro = (pro) => ({
  id: pro.id, name: pro.name, category: pro.category, state: pro.state,
  avatarColor: pro.avatarColor, tier: pro.tier, rating: pro.rating,
  jobsDone: pro.jobsDone, bio: pro.bio, responseMins: pro.responseMins,
  priceFrom: pro.priceFrom, priceLabel: pro.priceLabel, portfolio: pro.portfolio || [],
});

/** POST /api/auth/login   { identifier, password } */
export async function login(req, res) {
  const { identifier, password } = req.body || {};
  if (!identifier?.toString().trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ ok: false, error: 'Enter your WhatsApp number (or email) and password.' });
  }

  const idText = identifier.toString().trim().toLowerCase();
  const idPhone = normPhone(identifier);
  const key = idPhone.length === 10 ? 'p:' + idPhone : 'e:' + idText;

  const wait = lockedOut(key);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ ok: false, error: 'Too many attempts for this account. Please wait and try again.' });
  }

  const pro = await findVerifiedForLogin({ phoneKey: idPhone, email: idText });
  // Exactly one scrypt verification whether or not the account exists.
  const valid = await verifyPassword(password, pro?.password || await dummyHash);
  if (!pro || !pro.password || !valid) {
    recordFailure(key);
    return res.status(401).json({ ok: false, error: LOGIN_FAILED });
  }
  failures.delete(key);

  /**
   * CONTACT VERIFICATION GATE — blocks login for any account created on or
   * after OTP_ENFORCED_FROM that hasn't verified its code. This runs AFTER the
   * password check on purpose: issuing a code here requires proving you own
   * the account, so this endpoint can't be used to make us send SMS to
   * arbitrary numbers.
   */
  if (!passesOtpGate(pro)) {
    // Give them a live code to finish with, respecting the cooldown/hourly cap.
    const otp = await requestOtp({
      subjectType: 'pro', subjectId: pro.id,
      channel: 'sms', destination: pro.phone,
    });
    return res.status(403).json({
      ok: false,
      code: 'OTP_REQUIRED',
      error: 'Verify your phone number to finish setting up your account.',
      // otpId is returned even when a new send was suppressed (cooldown/cap) —
      // an earlier code may still be valid, so they always have a way forward.
      otp: otp.otpId
        ? { otpId: otp.otpId, channel: otp.channel, destinationMasked: otp.destinationMasked,
            expiresAt: otp.expiresAt, resendAvailableInSec: otp.resendAvailableInSec || 0,
            sent: Boolean(otp.ok) }
        : null,
      otpError: otp.ok ? null : otp.error,
      retryAfterSec: otp.retryAfterSec,
    });
  }

  // Upgrade hashes made with older cost parameters.
  if (needsRehash(pro.password)) {
    await updatePro(pro.id, { password: await hashPassword(password) });
  }

  const session = await createSession(pro.id);
  res.json({ ok: true, token: session.token, expiresAt: session.expiresAt, pro: dashboardPro(pro) });
}

/** POST /api/auth/logout — revokes the presented session. Always succeeds. */
export async function logout(req, res) {
  await revokeSession(bearerToken(req));
  res.json({ ok: true });
}

/** GET /api/auth/me — the signed-in pro (via requirePro). */
export function me(req, res) {
  res.json({ ok: true, pro: dashboardPro(req.pro), expiresAt: req.session.expiresAt });
}
