/**
 * Media storage for portfolio photos and job evidence.
 *
 * The client downscales photos (and keeps videos short) and sends them as data
 * URLs; we decode them to real files under /uploads (served statically by both
 * the Express app and serve.ps1) and store only the public URL.
 *
 * FUTURE: swap writeDataUrl()/writeMediaDataUrl() for an object-storage upload
 * (S3/Cloudinary) and return the CDN URL — callers keep working unchanged.
 * Video especially should move to object storage before production scale.
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root /uploads — already inside the static-served directory.
// Overridable via env (persistent disk in production; isolated dir in tests).
const UPLOAD_DIR = process.env.SERVORA_UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads');
const PUBLIC_PREFIX = '/uploads/';

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv' };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // decoded ceiling (client sends ~300KB)
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;  // short clips only; move to object storage for more

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

/** true for a value we already host (keep as-is on update). */
export const isStoredUrl = v => typeof v === 'string' && v.startsWith(PUBLIC_PREFIX);

function writeBuffer(buf, ext) {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return PUBLIC_PREFIX + name;
}

/**
 * Write a base64 IMAGE data URL to /uploads. Returns the public URL, or null
 * if the input isn't a supported image or is too large.
 */
export function writeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = IMAGE_EXT[mime];
  if (!ext) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  return writeBuffer(buf, ext);
}

/**
 * Write a base64 IMAGE or VIDEO data URL to /uploads. Returns { url, kind } or
 * null. Used for job evidence, where a phase needs both photos and a video.
 */
export function writeMediaDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const isVideo = Boolean(VIDEO_EXT[mime]);
  const ext = IMAGE_EXT[mime] || VIDEO_EXT[mime];
  if (!ext) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return null;
  if (buf.length > (isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) return null;
  return { url: writeBuffer(buf, ext), kind: isVideo ? 'video' : 'image' };
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

/**
 * Normalise submitted evidence photos + videos into stored URLs.
 * Accepts data URLs (written to disk) and existing /uploads URLs (kept).
 * Returns { photos:[url], videos:[url] }, each capped.
 */
export function persistEvidence(photos, videos, { maxPhotos = 8, maxVideos = 3 } = {}) {
  const outPhotos = [];
  const outVideos = [];
  for (const item of (Array.isArray(photos) ? photos : []).slice(0, maxPhotos)) {
    const v = typeof item === 'string' ? item : item?.url || item?.dataUrl;
    if (isStoredUrl(v)) outPhotos.push(v);
    else {
      const r = writeMediaDataUrl(v);
      if (r?.kind === 'image') outPhotos.push(r.url);
    }
  }
  for (const item of (Array.isArray(videos) ? videos : []).slice(0, maxVideos)) {
    const v = typeof item === 'string' ? item : item?.url || item?.dataUrl;
    if (isStoredUrl(v)) outVideos.push(v);
    else {
      const r = writeMediaDataUrl(v);
      if (r?.kind === 'video') outVideos.push(r.url);
    }
  }
  return { photos: outPhotos, videos: outVideos };
}
