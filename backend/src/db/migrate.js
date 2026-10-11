/**
 * Migration runner — applies backend/migrations/NNN_name.sql files in order.
 *
 *   • Every pending migration is applied in ONE transaction: either all of them
 *     land or none do (Postgres DDL is transactional).
 *   • A transaction-scoped advisory lock serialises concurrent starts (two
 *     instances booting at once). Transaction-scoped on purpose: Neon's pooler
 *     runs in transaction mode, where a session lock would not be held.
 *   • schema_migrations records each file's checksum. Editing a migration that
 *     has already run is refused — write a new migration instead.
 *
 * Runs automatically at server start, and on demand with `npm run migrate`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 72_441_001;   // arbitrary, constant: "servora migrations"

// Line endings normalised so a Windows checkout and Render's Linux checkout of
// the same file produce the same checksum.
const checksum = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export async function runMigrations({ log = console.log } = {}) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const ran = [];
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const sum = checksum(sql);
      if (applied.has(file)) {
        if (applied.get(file) !== sum) {
          throw new Error(`Migration ${file} was edited after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, sum]);
      ran.push(file);
    }
    log(ran.length ? `[db] applied migrations: ${ran.join(', ')}` : '[db] schema up to date');
    return { applied: ran, total: files.length };
  });
}
