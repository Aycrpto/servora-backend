/**
 * PRIVATE storage for KYC media (government ID documents + selfies).
 *
 * These are the most sensitive files in the system. Unlike portfolio photos,
 * they are deliberately NOT written to /uploads (which Express serves
 * statically to anyone). They live in backend/private/kyc/, are git-ignored,
 * and are only ever readable through the admin-authenticated review endpoint.
 *
 * Stored records keep a filename, never a public URL — there is no route that
 * serves these without an ADMIN_API_KEY check.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KYC_DIR = process.env.SERVORA_KYC_DIR || path.join(__dirname, '..', '..', 'private', 'kyc');

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Persist a KYC image from a data URL. Returns { file, bytes, mime } or null
 * if the input isn't a supported image or is too large.
 */
export function saveKycImage(dataUrl, kind = 'doc') {
  if (typeof dataUrl !== 'string') return null;
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) return null;

  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;

  if (!existsSync(KYC_DIR)) mkdirSync(KYC_DIR, { recursive: true });
  const file = `${kind}_${randomUUID()}.${ext}`;
  writeFileSync(path.join(KYC_DIR, file), buf);
  return { file, bytes: buf.length, mime: m[1].toLowerCase() };
}

/**
 * Read a stored KYC image for the admin reviewer.
 * Returns { buffer, mime } or null. Traversal-guarded: only plain filenames
 * that resolve inside KYC_DIR are ever opened.
 */
export function readKycImage(file) {
  if (typeof file !== 'string' || !/^[a-z]+_[a-f0-9-]+\.(jpg|png|webp)$/i.test(file)) return null;
  const full = path.join(KYC_DIR, file);
  if (path.dirname(full) !== path.resolve(KYC_DIR)) return null;
  if (!existsSync(full)) return null;
  return { buffer: readFileSync(full), mime: MIME[path.extname(full).slice(1).toLowerCase()] || 'application/octet-stream' };
}

/** Delete a stored KYC image (e.g. after a retention window). Best effort. */
export function deleteKycImage(file) {
  const r = readKycImage(file);
  if (!r) return false;
  try { unlinkSync(path.join(KYC_DIR, file)); return true; } catch { return false; }
}

export { KYC_DIR };
