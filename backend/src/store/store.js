/**
 * Storage layer — the ONLY module that knows data lives in a JSON file.
 * Upgrade path: replace these functions with SQLite/Postgres calls
 * (e.g. better-sqlite3 or Prisma); routes and controllers stay untouched.
 *
 * data/db.json is RUNTIME STATE and is git-ignored. On first run it is
 * created from data/db.seed.json (the 20 demo professionals), so a fresh
 * clone boots with a populated marketplace and every developer starts
 * from the same baseline. Delete db.json to reset back to the seed.
 *
 * ⚠️ Money note: this JSON store does whole-file read-modify-write with no
 * OS-level locking. That is fine for dev/test, but before holding REAL money
 * you should move the money tables (bookings/transactions/transactionEvents)
 * to a transactional DB. The mutate() helper below serializes writes within a
 * single process so concurrent webhook/release calls don't clobber each other.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The bundled data dir (ships with db.seed.json). The live db.json path can be
// pointed elsewhere via env — useful for a persistent disk in production, and
// for running an isolated test server that won't touch real data.
const APP_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_DIR = process.env.SERVORA_DATA_DIR || APP_DATA_DIR;
const DB_PATH = process.env.SERVORA_DB_PATH || path.join(DATA_DIR, 'db.json');
const SEED_PATH = path.join(APP_DATA_DIR, 'db.seed.json');

// New money collections are added here; loadDB() backfills them into any
// older db.json automatically via the spread merge below.
const EMPTY = {
  professionals: [], leads: [], supportMessages: [],
  bookings: [], transactions: [], transactionEvents: [], processedWebhooks: [],
  disputes: [],
  // Quote-based split-escrow flow: pro-issued quotes and the pre-job/completion
  // evidence attached to a booking. Backfilled into older db.json via the spread.
  quotes: [], evidence: [],
  // Cached State/LGA -> coordinates lookups. Nominatim's usage policy REQUIRES
  // caching; this keeps repeat geocodes off their servers entirely.
  geocodeCache: [],
};

/**
 * Read cache. The disk read dominates loadDB() (~32ms of ~45ms at 2.3MB), so we
 * cache the file CONTENTS keyed on mtime+size and re-parse per call. Parsing per
 * call is deliberate: several callers mutate the object they get back, so each
 * one must receive its own copy — sharing a parsed object would let a reader
 * corrupt the cache. (Re-parsing is still ~3.5x faster than re-reading.)
 */
let _cache = { key: null, text: null };

export function loadDB() {
  // First run (or after a reset): start from the seed.
  if (!existsSync(DB_PATH) && existsSync(SEED_PATH)) {
    try { copyFileSync(SEED_PATH, DB_PATH); } catch { /* fall through to EMPTY */ }
  }
  if (!existsSync(DB_PATH)) return structuredClone(EMPTY);
  try {
    const st = statSync(DB_PATH);
    const key = `${st.mtimeMs}:${st.size}`;
    if (_cache.key !== key) {
      _cache = { key, text: readFileSync(DB_PATH, 'utf8') };
    }
    // Spread order backfills any missing top-level collections (e.g. bookings).
    return { ...structuredClone(EMPTY), ...JSON.parse(_cache.text) };
  } catch {
    // Corrupt file — fail safe with an empty store rather than crashing.
    _cache = { key: null, text: null };
    return structuredClone(EMPTY);
  }
}

/**
 * ATOMIC write: serialise to a temp file in the same directory, then rename
 * over the target. rename() is atomic on POSIX and Windows (same volume), so a
 * crash mid-write can never leave a truncated db.json — readers see either the
 * old file or the new one, never a half-written mix. The previous direct
 * writeFileSync could destroy the entire database (bookings, transactions,
 * escrow records) on a power cut.
 */
export function saveDB(db) {
  const text = JSON.stringify(db, null, 2);
  const tmp = `${DB_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, DB_PATH);
  // Refresh the cache from what we just wrote instead of re-reading it.
  try { const st = statSync(DB_PATH); _cache = { key: `${st.mtimeMs}:${st.size}`, text }; }
  catch { _cache = { key: null, text: null }; }
}

/**
 * Serialized read-modify-write for money-critical mutations.
 *
 * `mutator(db)` runs SYNCHRONOUSLY (mutate the object, return a value); any
 * Paystack/network calls must happen OUTSIDE this function. Calls are chained
 * so no two mutations interleave their load→save window, which prevents lost
 * updates when a webhook and a release land at the same time.
 *
 *   const result = await mutate(db => { db.transactions.push(tx); return tx; });
 */
let _queue = Promise.resolve();
export function mutate(mutator) {
  const run = _queue.then(() => {
    const db = loadDB();
    const result = mutator(db);
    saveDB(db);
    return result;
  });
  // Keep the chain alive whether this mutation resolves or rejects.
  _queue = run.then(() => {}, () => {});
  return run;
}
