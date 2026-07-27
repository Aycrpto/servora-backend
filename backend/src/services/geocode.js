/**
 * Geocoding — turn a pro's State/LGA into approximate coordinates so we can
 * compute distance to a customer.
 *
 * Provider: OpenStreetMap Nominatim (free). Their usage policy is strict and
 * we comply with all of it (https://operations.osmfoundation.org/policies/nominatim/):
 *
 *   • "an absolute maximum of 1 request per second"  → global serialised queue,
 *     MIN_INTERVAL_MS between calls, process-wide.
 *   • "Results must be cached on your side"          → every lookup is cached in
 *     db.geocodeCache, keyed on the normalised query. Nigeria has 37 states and
 *     ~774 LGAs, so the cache saturates fast and steady-state traffic ≈ 0.
 *   • "provide a valid HTTP Referer or User-Agent identifying the application
 *     (stock User-Agents ... will not do)"           → USER_AGENT below.
 *   • "Systematic queries ... will get you banned"    → we geocode one place per
 *     registration, never enumerate. The backfill script throttles to 4/min,
 *     the documented rate for scripts run at regular intervals.
 *
 * Failure is always soft: a pro without coordinates simply can't be
 * distance-ranked and falls back to State/LGA text matching.
 */
import { loadDB, mutate } from '../store/store.js';

const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
/** Identifies this app per the policy. Override with a real contact in production. */
const USER_AGENT = process.env.GEOCODER_USER_AGENT || 'Servora/1.0 (Nigerian services marketplace; contact: support@servora.ng)';
const MIN_INTERVAL_MS = 1100;   // < 1 req/sec, with headroom
const TIMEOUT_MS = 10000;

/** Normalised cache key — "ikeja|lagos". */
const cacheKey = (lga, state) =>
  [lga, state].map((s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean).join('|');

/* ---- global 1-request-per-second queue (process-wide) ---- */
let _chain = Promise.resolve();
let _lastCallAt = 0;
function enqueue(fn) {
  const run = _chain.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - _lastCallAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    _lastCallAt = Date.now();
    return fn();
  });
  _chain = run.then(() => {}, () => {});
  return run;
}

/** Look up the cache without touching the network. */
export function cachedCoords(lga, state) {
  const key = cacheKey(lga, state);
  if (!key) return null;
  const hit = loadDB().geocodeCache.find((c) => c.key === key);
  return hit && hit.lat != null ? { lat: hit.lat, lng: hit.lng, source: 'cache' } : null;
}

/**
 * Geocode "LGA, State, Nigeria" to { lat, lng }. Returns null when the place
 * can't be resolved. Never throws — callers treat null as "no coordinates".
 * Results (including misses) are cached so we never re-ask for the same place.
 */
export async function geocodePlace(lga, state) {
  const key = cacheKey(lga, state);
  if (!key) return null;

  const db = loadDB();
  const hit = db.geocodeCache.find((c) => c.key === key);
  if (hit) return hit.lat != null ? { lat: hit.lat, lng: hit.lng, source: 'cache' } : null;

  const query = [lga, state, 'Nigeria'].filter(Boolean).join(', ');
  let result = null;
  try {
    result = await enqueue(async () => {
      const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=ng`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
          signal: ctrl.signal,
        });
        if (!r.ok) return null;
        const rows = await r.json().catch(() => null);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return null;
        const lat = Number(row.lat), lng = Number(row.lon);
        return Number.isFinite(lat) && Number.isFinite(lng)
          ? { lat, lng, displayName: row.display_name || null } : null;
      } finally { clearTimeout(timer); }
    });
  } catch {
    return null;   // network/timeout — don't cache a transient failure
  }

  // Cache hits AND misses (a miss is a real answer: "this place isn't resolvable").
  await mutate((d) => {
    if (d.geocodeCache.some((c) => c.key === key)) return;
    d.geocodeCache.push({
      key, query,
      lat: result ? result.lat : null,
      lng: result ? result.lng : null,
      displayName: result?.displayName ?? null,
      provider: 'nominatim',
      cachedAt: new Date().toISOString(),
    });
  });

  return result ? { lat: result.lat, lng: result.lng, source: 'nominatim' } : null;
}

/**
 * Great-circle distance in kilometres (Haversine). Pure maths, no API needed.
 * Accurate to well under 1% at city scale, which is far beyond what we need
 * for "who is closest".
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;                       // mean Earth radius, km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** True for a usable coordinate pair. */
export const hasCoords = (o) => Number.isFinite(o?.lat) && Number.isFinite(o?.lng);
