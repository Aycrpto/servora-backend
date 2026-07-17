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
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_PATH = path.join(DATA_DIR, 'db.seed.json');

// New money collections are added here; loadDB() backfills them into any
// older db.json automatically via the spread merge below.
const EMPTY = {
  professionals: [], leads: [], supportMessages: [],
  bookings: [], transactions: [], transactionEvents: [], processedWebhooks: [],
  disputes: [],
};

export function loadDB() {
  // First run (or after a reset): start from the seed.
  if (!existsSync(DB_PATH) && existsSync(SEED_PATH)) {
    try { copyFileSync(SEED_PATH, DB_PATH); } catch { /* fall through to EMPTY */ }
  }
  if (!existsSync(DB_PATH)) return structuredClone(EMPTY);
  try {
    // Spread order backfills any missing top-level collections (e.g. bookings).
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DB_PATH, 'utf8')) };
  } catch {
    // Corrupt file — fail safe with an empty store rather than crashing.
    return structuredClone(EMPTY);
  }
}

export function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
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
