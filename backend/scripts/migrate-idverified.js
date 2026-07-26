#!/usr/bin/env node
/**
 * One-off migration: backfill `idVerified` on professionals created BEFORE
 * real KYC existed.
 *
 * Why it's needed: the ID-Verified badge is now derived from `idVerified`
 * rather than the raw `badges` array. Records written by the old code have no
 * such field, so after deploying they would silently lose their badge.
 *
 * What it does: for every professional with status 'verified' that has no
 * idVerification record, it sets idVerified=true and stamps an explicit
 * `legacy_pre_kyc` marker — so these are auditable as "trusted before
 * automated KYC existed", never mistaken for a real Dojah pass.
 *
 * Usage (from the backend directory):
 *   node scripts/migrate-idverified.js --dry-run    # show what would change
 *   node scripts/migrate-idverified.js              # apply (writes a backup)
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SERVORA_DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const DRY = process.argv.includes('--dry-run');

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}`);
  process.exit(1);
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const pros = db.professionals || [];

const needing = pros.filter(p => p.status === 'verified' && !p.idVerification && p.idVerified !== true);
const alreadyOk = pros.filter(p => p.idVerified === true).length;

console.log(`Database : ${DB_PATH}`);
console.log(`Pros     : ${pros.length} total · ${alreadyOk} already flagged · ${needing.length} to migrate`);

if (!needing.length) { console.log('Nothing to do.'); process.exit(0); }

for (const p of needing) {
  console.log(`  ${DRY ? '[dry-run] would set' : 'set'} idVerified=true  ${p.name} (${p.category || '—'})`);
  if (DRY) continue;
  p.idVerified = true;
  p.badges = Array.from(new Set([...(p.badges || []), 'v']));
  p.idVerification = {
    provider: 'legacy',
    outcome: 'legacy_pre_kyc',
    confidence: null, match: null,
    reasons: ['Account predates automated ID verification; trusted on migration.'],
    checks: {}, checkedAt: p.createdAt || new Date().toISOString(),
    error: null, raw: null, endpoint: null, environment: null,
    thresholdUsed: null, httpStatus: null,
    decidedBy: null, decidedAt: null, decisionReason: null,
  };
}

if (DRY) { console.log('\nDry run — nothing written.'); process.exit(0); }

const backup = DB_PATH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(DB_PATH, backup);
writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
console.log(`\nBackup  : ${backup}`);
console.log(`Migrated: ${needing.length} professional(s).`);
