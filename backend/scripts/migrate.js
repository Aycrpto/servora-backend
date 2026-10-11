#!/usr/bin/env node
/**
 * Apply pending database migrations, then exit.
 * The server also does this at start; this is for running it on demand.
 *
 *   npm run migrate        (needs DATABASE_URL in the environment or backend/.env)
 */
import { DB_CONFIGURED, closePool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

if (!DB_CONFIGURED) {
  console.error('DATABASE_URL is not set — nothing to migrate.');
  process.exit(1);
}
try {
  await runMigrations();
} catch (err) {
  console.error('[db] migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
