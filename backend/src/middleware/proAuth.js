/**
 * Professional authentication.
 *
 * requirePro    — the request must carry `Authorization: Bearer <session token>`
 *                 for a live session of a verified, contact-verified pro. Sets
 *                 req.pro (full record) and req.session.
 * requireSelf() — the :id in the URL must be that same pro.
 *
 * A pro whose verification is later withdrawn loses access on their next
 * request, even with an unexpired session.
 */
import { findSession } from '../store/sessions.js';
import { getPro } from '../store/professionals.js';
import { passesOtpGate } from '../config.js';

export const bearerToken = (req) => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
};

// `code` lets the frontend tell "sign in again" apart from other 401s.
const signInAgain = (res) =>
  res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Please sign in again.' });

export async function requirePro(req, res, next) {
  const session = await findSession(bearerToken(req));
  if (!session) return signInAgain(res);
  const pro = await getPro(session.proId);
  if (!pro || pro.status !== 'verified' || !passesOtpGate(pro)) return signInAgain(res);
  req.pro = pro;
  req.session = session;
  next();
}

export const requireSelf = (param = 'id') => (req, res, next) =>
  (String(req.params[param]) === String(req.pro?.id)
    ? next()
    : res.status(403).json({ ok: false, error: 'You can only manage your own account.' }));
