/**
 * Database start-up and readiness.
 *
 * The server starts listening straight away (Render expects the port bound
 * quickly) and applies migrations in the background. If Neon is unreachable —
 * a cold start, a blip — it keeps retrying with backoff instead of crashing,
 * and database-backed routes wait briefly for readiness before answering 503.
 */
import { DB_CONFIGURED } from './pool.js';
import { runMigrations } from './migrate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

let state = DB_CONFIGURED ? 'starting' : 'not_configured';   // → 'ready' | 'error'
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

/** 'not_configured' | 'starting' | 'error' (retrying) | 'ready' */
export const dbStatus = () => state;

/** Apply migrations, retrying until the database answers. Never throws. */
export async function startDatabase() {
  if (!DB_CONFIGURED) {
    console.error('[db] DATABASE_URL is not set. The site will load, but every database-backed ' +
      'API route answers 503 until it is configured.');
    return;
  }
  for (let delay = 2000; ; delay = Math.min(delay * 2, 60_000)) {
    try {
      await runMigrations();
      state = 'ready';
      markReady();
      return;
    } catch (err) {
      state = 'error';
      console.error(`[db] not ready (${err.code || 'error'}: ${err.message}) — retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/** Express middleware for routes that need Postgres. */
export async function requireDb(_req, res, next) {
  if (state === 'ready') return next();
  if (state === 'not_configured') {
    return res.status(503).json({ ok: false, error: 'The database is not configured on this server.' });
  }
  // Starting or recovering: give it a moment rather than failing instantly.
  const ok = await Promise.race([ready.then(() => true), sleep(15_000).then(() => false)]);
  if (ok) return next();
  res.set('Retry-After', '10').status(503)
    .json({ ok: false, error: 'The service is starting up. Please try again in a moment.' });
}
