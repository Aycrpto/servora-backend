/** Registration OTP requests and their successful sends (for rate limiting). */
import { db, withTransaction } from '../db/pool.js';
import { iso } from './util.js';

function toOtp(r) {
  if (!r) return null;
  return {
    id: r.id,
    subjectType: 'pro',
    subjectId: r.pro_id,
    channel: r.channel,
    destination: r.destination,
    provider: r.provider,
    pinId: r.pin_id,
    codeHash: r.code_hash,
    expiresAt: iso(r.expires_at),
    attempts: r.attempts,
    sends: (r.sends || []).map(iso),
    verifiedAt: iso(r.verified_at),
    lastError: r.last_error,
    lastErrorAt: iso(r.last_error_at),
    createdAt: iso(r.created_at),
  };
}

const SELECT = `SELECT r.*, COALESCE(
    (SELECT array_agg(s.sent_at ORDER BY s.sent_at) FROM otp_sends s WHERE s.otp_request_id = r.id),
    '{}') AS sends
  FROM otp_requests r`;

export async function getOtpRequest(id) {
  const { rows } = await db().query(`${SELECT} WHERE r.id = $1`, [String(id)]);
  return toOtp(rows[0]);
}

/** The live (unverified) request for this pro + destination, if any. */
export async function findLiveOtp(proId, destination) {
  const { rows } = await db().query(
    `${SELECT} WHERE r.pro_id = $1 AND r.destination = $2 AND r.verified_at IS NULL`, [proId, destination]);
  return toOtp(rows[0]);
}

/** Successful sends to a destination in the last hour, newest first (ISO strings). */
export async function sendsInLastHour(destination) {
  const { rows } = await db().query(
    `SELECT sent_at FROM otp_sends
      WHERE destination = $1 AND sent_at > now() - interval '1 hour'
      ORDER BY sent_at DESC`, [destination]);
  return rows.map((r) => iso(r.sent_at));
}

/** Create the live request for pro + destination, or return the existing one. */
export async function ensureOtpRequest({ id, proId, channel, destination, provider }) {
  await db().query(
    `INSERT INTO otp_requests (id, pro_id, channel, destination, provider)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (pro_id, destination) WHERE verified_at IS NULL DO NOTHING`,
    [id, proId, channel, destination, provider]);
  return findLiveOtp(proId, destination);
}

export async function recordOtpSendFailure(id, error) {
  await db().query('UPDATE otp_requests SET last_error = $2, last_error_at = now() WHERE id = $1', [id, error]);
}

/** A delivered code: it becomes the only valid one, and the send counts toward the cap. */
export async function recordOtpSendSuccess(id, { pinId, codeHash, expiresAt, destination }) {
  await withTransaction(async (c) => {
    await c.query(
      `UPDATE otp_requests SET pin_id = $2, code_hash = $3, expires_at = $4, attempts = 0,
              last_error = NULL WHERE id = $1`, [id, pinId, codeHash, expiresAt]);
    await c.query('INSERT INTO otp_sends (otp_request_id, destination) VALUES ($1, $2)', [id, destination]);
  });
}

export async function incrementOtpAttempts(id) {
  await db().query('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1', [id]);
}

/** The code is spent: mark verified and drop the pin/hash. */
export async function markOtpVerified(id) {
  await db().query(
    'UPDATE otp_requests SET verified_at = now(), code_hash = NULL, pin_id = NULL WHERE id = $1', [id]);
}
