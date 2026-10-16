/**
 * Cloudflare R2 (S3-compatible API) for private files — today, KYC images.
 *
 * Zero dependencies: requests are signed with AWS Signature V4 using
 * node:crypto (signer verified against AWS's published test vectors). The
 * bucket is PRIVATE and in the EU jurisdiction; nothing in it has a public
 * URL. Reads happen only through short-lived presigned GET links, and only
 * after the caller has done its own authorisation (the admin key check).
 *
 * Env (all required; there is deliberately no local-disk fallback for ID
 * images — without R2, registration refuses rather than storing them on the
 * server's disk):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   R2_JURISDICTION  'eu' (default) → https://<account>.eu.r2.cloudflarestorage.com
 *   R2_ENDPOINT      optional full override (local stand-in for tests)
 * Signed URLs and secrets are never logged.
 */
import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');
const amzDates = (date) => {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // 20130524T000000Z
  return { amzDate: iso, day: iso.slice(0, 8) };
};

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
}

function canonicalQuery(params) {
  return Object.keys(params).sort().map((k) => `${enc(k)}=${enc(String(params[k]))}`).join('&');
}

/**
 * Sign a request with an Authorization header (SigV4). `headers` must include
 * host; x-amz-date and x-amz-content-sha256 are added. Returns the headers to send.
 * Exported for the signer tests.
 */
export function signHeaders({ method, path, query = {}, headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
  const { amzDate, day } = amzDates(date);
  const all = { ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = names.join(';');
  const canonical = [method, encPath(path), canonicalQuery(query), names.map((n) => `${n}:${lower[n]}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(secretAccessKey, day, region, service)).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** Presigned GET (query-string auth, host-only signed). Exported for the signer tests. */
export function presign({ method = 'GET', host, path, expires, accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
  const { amzDate, day } = amzDates(date);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonical = [method, encPath(path), canonicalQuery(query), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(secretAccessKey, day, region, service)).update(toSign).digest('hex');
  return `${encPath(path)}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/* ------------------------------------------------------------ the R2 client */

function cfg() {
  const e = process.env;
  const c = {
    accountId: e.R2_ACCOUNT_ID || '', accessKeyId: e.R2_ACCESS_KEY_ID || '', secretAccessKey: e.R2_SECRET_ACCESS_KEY || '',
    bucket: e.R2_BUCKET || '', jurisdiction: (e.R2_JURISDICTION || 'eu').toLowerCase(), endpoint: e.R2_ENDPOINT || '',
  };
  if (!c.endpoint && c.accountId) {
    c.endpoint = `https://${c.accountId}.${c.jurisdiction === 'default' ? '' : c.jurisdiction + '.'}r2.cloudflarestorage.com`;
  }
  return c;
}

/** True when every R2 setting is present. */
export function r2Configured() {
  const c = cfg();
  return Boolean(c.endpoint && c.accessKeyId && c.secretAccessKey && c.bucket);
}

export class StorageError extends Error {
  constructor(message, status) { super(message); this.name = 'StorageError'; this.status = status ?? null; }
}

async function send(method, key, { body, contentType } = {}) {
  const c = cfg();
  if (!r2Configured()) throw new StorageError('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  const url = new URL(c.endpoint);
  const path = `/${c.bucket}/${key}`;
  const headers = { host: url.host };
  if (contentType) headers['content-type'] = contentType;
  const signed = signHeaders({ method, path, headers, payloadHash: sha256Hex(body || ''), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: 'auto' });
  delete signed.host;   // fetch sets it itself (same value)
  let r;
  try {
    r = await fetch(url.origin + encPath(path), { method, headers: signed, body, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new StorageError(`R2 ${method} failed: ${err.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
  }
  if (!r.ok && !(method === 'DELETE' && r.status === 404)) {
    const code = (await r.text().catch(() => '')).match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new StorageError(`R2 ${method} failed: HTTP ${r.status}${code ? ' ' + code : ''}`, r.status);
  }
  return r;
}

/** Store bytes under `key`. Throws StorageError on any failure. */
export async function putObject(key, body, contentType) {
  await send('PUT', key, { body, contentType });
  return { key, bytes: body.length };
}

/** Delete `key`. Already-gone counts as success. Throws StorageError otherwise. */
export async function deleteObject(key) {
  await send('DELETE', key);
  return true;
}

/** Whether `key` exists (for tests and the retention job's checks). */
export async function objectExists(key) {
  const c = cfg();
  const url = new URL(c.endpoint);
  const path = `/${c.bucket}/${key}`;
  const signed = signHeaders({ method: 'HEAD', path, headers: { host: url.host }, payloadHash: sha256Hex(''), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: 'auto' });
  delete signed.host;
  const r = await fetch(url.origin + encPath(path), { method: 'HEAD', headers: signed, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return false;
  if (!r.ok) throw new StorageError(`R2 HEAD failed: HTTP ${r.status}`, r.status);
  return true;
}

/** A GET link for `key` valid for `seconds` (60 by default). Caller authorises first. */
export function signedGetUrl(key, seconds = 60) {
  const c = cfg();
  if (!r2Configured()) throw new StorageError('R2 is not configured.');
  const url = new URL(c.endpoint);
  return url.origin + presign({ host: url.host, path: `/${c.bucket}/${key}`, expires: seconds, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: 'auto' });
}
