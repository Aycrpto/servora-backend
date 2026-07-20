/**
 * Zero-dependency, in-memory, fixed-window rate limiter for sensitive
 * endpoints (login, registration, payment initialization).
 *
 * Per-process only — good enough for a single Node instance. If Servora ever
 * runs multiple instances, swap for a shared store (Redis) behind this seam.
 */
const buckets = new Map(); // key -> { count, resetAt }

// Prune expired windows occasionally so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

/**
 * rateLimit({ windowMs, max, name }) → Express middleware.
 * Keyed by client IP (X-Forwarded-For aware — set trust proxy behind Nginx).
 */
export function rateLimit({ windowMs = 60_000, max = 20, name = 'rl' } = {}) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}
