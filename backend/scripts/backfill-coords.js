#!/usr/bin/env node
/**
 * Backfill approximate coordinates for professionals registered before
 * location matching existed.
 *
 * RATE LIMIT: Nominatim's policy allows an absolute maximum of 1 request per
 * second, and explicitly restricts "scripts running at regular intervals" to
 * 4 requests per minute. This script therefore paces itself at 15s per
 * NETWORK lookup (4/min) and forbids parallelism. Cache hits are free and are
 * not paced, so re-runs finish almost instantly.
 *
 * Bulk/systematic querying is a bannable offence under that policy — do not
 * lower the interval.
 *
 * Usage (from the backend directory):
 *   node scripts/backfill-coords.js --dry-run
 *   node scripts/backfill-coords.js [--limit 50]
 */
import { loadDB, mutate } from '../src/store/store.js';
import { geocodePlace, cachedCoords } from '../src/services/geocode.js';

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const PACE_MS = 15000;   // 4 network requests per minute

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pros = loadDB().professionals.filter(p => !p.location?.lat && (p.lga || p.state));
console.log(`${pros.length} professional(s) without coordinates.`);
if (!pros.length) process.exit(0);

let done = 0, cached = 0, fetched = 0, failed = 0;

for (const pro of pros.slice(0, LIMIT)) {
  const place = [pro.lga, pro.state].filter(Boolean).join(', ');
  const hit = cachedCoords(pro.lga, pro.state);

  if (DRY) {
    console.log(`  [dry-run] ${pro.name} — ${place} ${hit ? '(cached, free)' : '(needs a network lookup)'}`);
    done++; continue;
  }

  let coords = hit;
  if (coords) {
    cached++;
  } else {
    coords = await geocodePlace(pro.lga, pro.state);
    fetched++;
  }

  if (coords) {
    await mutate(d => {
      const p = d.professionals.find(x => String(x.id) === String(pro.id));
      if (p && !p.location) p.location = coords;
    });
    console.log(`  ✓ ${pro.name} — ${place} -> ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)} (${coords.source})`);
  } else {
    failed++;
    console.log(`  ✗ ${pro.name} — ${place} could not be resolved (stays text-matched)`);
  }
  done++;

  // Pace only when we actually hit the network.
  if (!hit && done < Math.min(pros.length, LIMIT)) await sleep(PACE_MS);
}

console.log(`\nDone: ${done} processed · ${cached} from cache · ${fetched} network lookups · ${failed} unresolved`);
