/**
 * Postgres connection pool (Neon, via its pooled endpoint).
 *
 * Tuned for where this runs: a Render free instance (512MB RAM, 0.1 CPU) that
 * sleeps after 15 minutes idle, talking to a Neon compute that scales to zero.
 *
 *   • max 5 connections — Neon's pooler does the real fan-out; more sockets
 *     here would only cost memory on a tiny instance.
 *   • idle connections close after 30s, long before Neon suspends its compute,
 *     so the pool rarely holds a socket the server has already dropped.
 *   • 15s to connect — covers Neon waking from zero (normally well under 5s).
 *   • an 'error' listener on the pool: without it, Neon closing an IDLE
 *     connection emits an unhandled 'error' event and crashes the process.
 *
 * Neon's pooled endpoint runs PgBouncer in TRANSACTION mode, so nothing here
 * relies on session state (no session SETs, no session advisory locks).
 */
import pg from 'pg';
import { DATABASE_URL } from '../config.js';

// int8 (bigint) arrives as a string by default. Every bigint here is kobo,
// far below 2^53, so a plain Number is exact. numeric → Number for ratings
// and confidence scores.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const DB_CONFIGURED = Boolean(DATABASE_URL);

/**
 * Two libpq URL settings that node-postgres handles differently:
 *   • sslmode=require: pg currently verifies the full certificate chain (as
 *     verify-full) and warns that its next major version will weaken this.
 *     Pinned to verify-full so the strong behaviour can't silently change.
 *   • channel_binding=require: pg ignores it in the URL; it must be switched on
 *     with enableChannelBinding (SCRAM-SHA-256-PLUS).
 * The URL itself is never logged.
 */
function connectionOptions(url) {
  const u = new URL(url);
  if (['prefer', 'require', 'verify-ca'].includes(u.searchParams.get('sslmode'))) {
    u.searchParams.set('sslmode', 'verify-full');
  }
  const binding = u.searchParams.get('channel_binding');
  u.searchParams.delete('channel_binding');
  return { connectionString: u.toString(), enableChannelBinding: binding === 'require' || binding === 'prefer' };
}

export const pool = DB_CONFIGURED ? new pg.Pool({
  ...connectionOptions(DATABASE_URL),
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  query_timeout: 20_000,      // a hung query can't pin a connection forever
  keepAlive: true,
}) : null;

pool?.on('error', (err) => {
  console.error('[db] idle connection dropped (will reconnect on next use):', err.message);
});

/** Thrown when DATABASE_URL is missing, so routes can answer 503 cleanly. */
export class DbNotConfiguredError extends Error {
  constructor() { super('DATABASE_URL is not set.'); this.code = 'DB_NOT_CONFIGURED'; }
}

const CONNECTION_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01', '57P02', '57P03',          // admin/crash shutdown, cannot connect now (compute waking)
  '08000', '08001', '08003', '08004', '08006',
]);

/** True for errors where the connection (not the query) failed. */
export function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_CODES.has(err.code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i
    .test(err.message || '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Check out a client, retrying ONCE if the connection itself fails (e.g. a cold start). */
async function acquire() {
  if (!pool) throw new DbNotConfiguredError();
  try {
    return await pool.connect();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    await sleep(500);
    return pool.connect();
  }
}

/**
 * Run one parameterised statement. A failed CONNECT is retried (nothing was
 * sent). A connection lost mid-query is retried only for reads — a write
 * might already have been applied, so it is surfaced instead of repeated.
 */
export async function query(text, params = []) {
  for (let attempt = 1; ; attempt++) {
    const client = await acquire();
    try {
      const res = await client.query(text, params);
      client.release();
      return res;
    } catch (err) {
      const lost = isConnectionError(err);
      client.release(lost ? err : undefined);   // destroy a broken socket
      if (lost && attempt === 1 && /^\s*(SELECT|WITH)\b/i.test(text)) { await sleep(300); continue; }
      throw err;
    }
  }
}

/**
 * Run `fn(client)` inside a transaction. If the connection drops BEFORE
 * COMMIT, Postgres has rolled everything back, so the whole function is safely
 * retried once. If it drops DURING commit the outcome is unknown, so it is
 * never retried — callers that move money must not be replayed blindly.
 * `fn` must not make network calls (Paystack, SMS); do those outside.
 */
export async function withTransaction(fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await acquire();
    let committing = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      committing = true;
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        client.release(err);
        if (!committing && attempt === 1) { await sleep(300); continue; }
        throw err;
      }
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
  }
}

/** Use the caller's transaction client when given one, else the pool. */
export const db = (client) => client || { query };

export async function closePool() {
  if (pool) await pool.end().catch(() => {});
}
