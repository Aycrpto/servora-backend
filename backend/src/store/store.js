/**
 * Storage layer — the ONLY module that knows data lives in a JSON file.
 * Upgrade path: replace these functions with SQLite/Postgres calls
 * (e.g. better-sqlite3 or Prisma); routes and controllers stay untouched.
 *
 * data/db.json is RUNTIME STATE and is git-ignored. On first run it is
 * created from data/db.seed.json (the 20 demo professionals), so a fresh
 * clone boots with a populated marketplace and every developer starts
 * from the same baseline. Delete db.json to reset back to the seed.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_PATH = path.join(DATA_DIR, 'db.seed.json');

const EMPTY = { professionals: [], leads: [], supportMessages: [] };

export function loadDB() {
  // First run (or after a reset): start from the seed.
  if (!existsSync(DB_PATH) && existsSync(SEED_PATH)) {
    try { copyFileSync(SEED_PATH, DB_PATH); } catch { /* fall through to EMPTY */ }
  }
  if (!existsSync(DB_PATH)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DB_PATH, 'utf8')) };
  } catch {
    // Corrupt file — fail safe with an empty store rather than crashing.
    return structuredClone(EMPTY);
  }
}

export function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}
