/**
 * Password-reset tokens. The raw token exists only in the reset link; the
 * database keeps its SHA-256 (a fast hash is right for 256 random bits).
 */
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db/pool.js';

export const RESET_TTL_MS = 60 * 60 * 1000;   // 1 hour
const TOKEN_RE = /^pr_[A-Za-z0-9_-]{43}$/;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Reset requests issued for this pro in the last hour (the per-account limit). */
export async function recentResetCount(proId, client) {
  const { rows } = await db(client).query(
    "SELECT count(*)::int AS n FROM password_resets WHERE pro_id = $1 AND created_at > now() - interval '1 hour'",
    [proId]);
  return rows[0].n;
}

/**
 * Issue a token for a pro, retiring any older unused ones so only the newest
 * link works. Returns the raw token (for the email) and its expiry.
 */
export async function createResetToken(proId, client) {
  const token = 'pr_' + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db(client).query('UPDATE password_resets SET used_at = now() WHERE pro_id = $1 AND used_at IS NULL', [proId]);
  await db(client).query(
    'INSERT INTO password_resets (token_hash, pro_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), proId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Spend a token, atomically: only an unused, unexpired token matches, and the
 * same UPDATE marks it used — two concurrent uses can't both succeed.
 * Returns the pro id, or null. Must run inside the reset transaction.
 */
export async function consumeResetToken(client, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const { rows } = await client.query(
    `UPDATE password_resets SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING pro_id`, [hashToken(token)]);
  return rows[0]?.pro_id || null;
}

/** Retire every outstanding token for a pro (after a successful reset). */
export async function retireResetTokens(client, proId) {
  await client.query('UPDATE password_resets SET used_at = now() WHERE pro_id = $1 AND used_at IS NULL', [proId]);
}
