/**
 * Image storage for portfolio photos.
 *
 * The client downscales photos and sends them as data URLs; we decode
 * them to real files under /uploads (served statically by both the
 * Express app and serve.ps1) and store only the public URL on the pro.
 *
 * FUTURE: swap writeDataUrl() for an object-storage upload (S3/Cloudinary)
 * and return the CDN URL — callers keep working unchanged.
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root /uploads — already inside the static-served directory.
const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');
const PUBLIC_PREFIX = '/uploads/';
const MAX_BYTES = 8 * 1024 * 1024; // decoded ceiling (client sends ~300KB)

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** true for a value we already host (keep as-is on update). */
export const isStoredUrl = v => typeof v === 'string' && v.startsWith(PUBLIC_PREFIX);

/**
 * Write a base64 data URL to /uploads. Returns the public URL, or null
 * if the input isn't a supported image or is too large.
 */
export function writeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;

  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;

  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${randomUUID()}.${EXT[m[1]] || 'jpg'}`;
  writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return PUBLIC_PREFIX + name;
}

/** Delete a file we host. Never touches anything outside /uploads. */
export function deleteStored(url) {
  if (!isStoredUrl(url)) return;
  const name = path.basename(url);
  const file = path.join(UPLOAD_DIR, name);
  // guard against traversal via a crafted URL
  if (path.dirname(file) !== UPLOAD_DIR) return;
  try { if (existsSync(file)) unlinkSync(file); } catch { /* best effort */ }
}

/**
 * Normalise a submitted portfolio array into stored URLs.
 * Accepts data URLs (written to disk) and existing /uploads URLs (kept).
 * Anything else is dropped. Capped at `max` entries.
 */
export function persistPortfolio(list, max = 5) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, max)) {
    const v = typeof item === 'string' ? item : item?.url || item?.dataUrl;
    if (isStoredUrl(v)) out.push(v);
    else {
      const url = writeDataUrl(v);
      if (url) out.push(url);
    }
  }
  return out;
}
