/**
 * Shared admin authentication.
 *
 * Compares the x-admin-key header against ADMIN_API_KEY in CONSTANT TIME.
 * A plain `===` on secrets short-circuits at the first differing byte, which
 * leaks key material through response timing; timingSafeEqual does not.
 *
 * Fails closed: if ADMIN_API_KEY is unset, nothing is authorised.
 */
import { timingSafeEqual } from 'node:crypto';
import { ADMIN_API_KEY } from '../config.js';

/** Constant-time string compare that doesn't leak length via early return. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  // Compare equal-length digests so differing lengths still cost the same.
  if (ab.length !== bb.length) {
    // Still perform a comparison to keep timing flat, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** True when the request carries the correct admin key. */
export function isAdmin(req) {
  if (!ADMIN_API_KEY) return false;
  return safeEqual(req.headers['x-admin-key'], ADMIN_API_KEY);
}

/** Express middleware: 401s anything without a valid admin key. */
export function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  next();
}
