/**
 * PRIVATE storage for KYC media (government ID documents + selfies).
 *
 * These are the most sensitive files in the system. They live in a private
 * Cloudflare R2 bucket (EU jurisdiction) — never on the server's disk (Render's
 * disk is wiped on every deploy) and never under /uploads. There is no public
 * URL: a reviewer gets a 60-second signed link, issued only after the
 * ADMIN_API_KEY check (kyc.controller.js).
 *
 * Postgres keeps only the R2 object key (professionals.kyc_id_image_key /
 * kyc_selfie_key): kyc/<pro id>/<idDocument|selfie>-<uuid>.<ext>.
 */
import { randomUUID } from 'node:crypto';
import { putObject, deleteObject, signedGetUrl, r2Configured, StorageError } from '../services/r2.js';

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
export const KYC_KINDS = ['idDocument', 'selfie'];
/** How long a reviewer's signed link to an ID image lives. */
export const KYC_LINK_SECONDS = 60;

export { r2Configured as kycStorageReady, StorageError };

/**
 * Decode and check a KYC image from a data URL, without storing anything.
 * Returns { buf, mime, ext } or null if it isn't a supported image or is too large.
 */
export function decodeKycImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { buf, mime, ext: EXT[mime] };
}

/**
 * Upload a pro's decoded ID and selfie to R2. All or nothing: if either upload
 * fails, whatever was stored is deleted and a StorageError is thrown.
 * Returns { idDocument: key, selfie: key }.
 */
export async function storeKycImages(proId, images) {
  const keys = {};
  try {
    for (const kind of KYC_KINDS) {
      const img = images[kind];
      const key = `kyc/${proId}/${kind}-${randomUUID()}.${img.ext}`;
      await putObject(key, img.buf, img.mime);
      keys[kind] = key;
    }
    return keys;
  } catch (err) {
    await deleteKycImages(Object.values(keys));
    throw err instanceof StorageError ? err : new StorageError('Could not store the ID images.');
  }
}

/** Best-effort delete of stored KYC objects (cleanup paths). Returns how many went. */
export async function deleteKycImages(keys) {
  let n = 0;
  for (const key of keys.filter(Boolean)) {
    try { await deleteObject(key); n++; } catch { /* reported by the caller's own checks */ }
  }
  return n;
}

/** A signed link to one stored KYC image. The CALLER must have checked the admin key. */
export function kycImageLink(key) {
  return signedGetUrl(key, KYC_LINK_SECONDS);
}
