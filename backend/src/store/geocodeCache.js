/** Nominatim results cache (hits AND misses), required by their usage policy. */
import { db } from '../db/pool.js';

export async function getCachedPlace(key) {
  const { rows } = await db().query('SELECT key, lat, lng FROM geocode_cache WHERE key = $1', [key]);
  return rows[0] || null;
}

export async function cachePlace({ key, query, lat, lng, displayName, provider }) {
  await db().query(
    `INSERT INTO geocode_cache (key, query, lat, lng, display_name, provider)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
    [key, query, lat, lng, displayName ?? null, provider]);
}
