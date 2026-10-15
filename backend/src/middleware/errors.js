/**
 * Central JSON error handler. Async route errors reach it through
 * middleware/asyncRouter.js. Never echoes request bodies (they carry PII).
 */
import { isConnectionError } from '../db/pool.js';

/**
 * Booking, quote, dispute and payment ids in URLs act as access tokens for
 * customers (who have no account), so they are masked before a path is logged.
 */
export const safePath = (p) => String(p).replace(
  /\/(?:(bk|qt|dsp|txn|ev|otp)_[\w-]+|SRV_[\w-]+|[0-9a-f]{8}-[0-9a-f-]{27})(?=\/|$)/gi,
  (_m, prefix) => `/${prefix ? prefix + '_' : ''}…`);

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'That upload is too large.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'The request body is not valid JSON.' });
  }
  if (err?.code === 'DB_NOT_CONFIGURED') {
    return res.status(503).json({ ok: false, error: 'The database is not configured on this server.' });
  }
  if (isConnectionError(err)) {
    console.error(`[db] ${req.method} ${safePath(req.path)} failed: connection problem (${err.code || err.message})`);
    return res.set('Retry-After', '5').status(503)
      .json({ ok: false, error: 'The service is temporarily unavailable. Please try again in a moment.' });
  }
  console.error(`[api] ${req.method} ${safePath(req.path)} failed:`, err?.stack || err);
  res.status(500).json({ ok: false, error: 'Something went wrong.' });
}
