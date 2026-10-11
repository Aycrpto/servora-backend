/**
 * Professional sign-in sessions.
 *
 * A token is 32 random bytes (base64url) with an "sv_" prefix. It is shown to
 * the client exactly once, at sign-in; the database keeps only its SHA-256
 * hash. A fast hash is right here: the token is high-entropy random data, not
 * a guessable password, so there is nothing to brute-force.
 */
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { iso } from './util.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const TOKEN_RE = /^sv_[A-Za-z0-9_-]{43}$/;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Cheap shape check, so junk (e.g. an old "demo-…" string) never reaches the database. */
export const looksLikeToken = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** Start a session. Returns the raw token (give it to the client) and its expiry. */
export async function createSession(proId) {
  const token = 'sv_' + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db().query(
    'INSERT INTO pro_sessions (token_hash, pro_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), proId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * The live session for a token: not revoked, not expired. Returns
 * { sessionId, proId, expiresAt } or null.
 */
export async function findSession(token) {
  if (!looksLikeToken(token)) return null;
  const { rows } = await db().query(
    `SELECT id, pro_id, expires_at, last_used_at FROM pro_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [hashToken(token)]);
  const s = rows[0];
  if (!s) return null;
  // Record activity at most every 15 minutes rather than writing on every request.
  if (Date.now() - new Date(s.last_used_at).getTime() > 15 * 60 * 1000) {
    await db().query('UPDATE pro_sessions SET last_used_at = now() WHERE id = $1', [s.id]);
  }
  return { sessionId: s.id, proId: s.pro_id, expiresAt: iso(s.expires_at) };
}

/** Sign out: revoke this one session. Idempotent. */
export async function revokeSession(token) {
  if (!looksLikeToken(token)) return;
  await db().query(
    'UPDATE pro_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
}

/** Revoke every session a professional has (e.g. after a password change). */
export async function revokeAllSessions(proId) {
  await db().query('UPDATE pro_sessions SET revoked_at = now() WHERE pro_id = $1 AND revoked_at IS NULL', [proId]);
}
