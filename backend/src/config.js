/** Central config — everything overridable via environment variables. */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny zero-dependency .env loader. Reads backend/.env (if present) and
 * populates process.env for any key not already set by the real environment.
 * Keeps secrets (Paystack keys) out of code and out of git. Real env vars win.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue; // skips blanks and # comments
    if (m[1] in process.env) continue; // don't override the real environment
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

export const PORT = process.env.PORT || 8321;

/**
 * Postgres (Neon) connection string. Read from the environment ONLY — never
 * hard-code it or write it into docs. Empty = the API boots, but every
 * database-backed route answers 503 until it is set.
 */
export const DATABASE_URL = process.env.DATABASE_URL || '';

/**
 * Professional sign-up collects government ID photos and selfies. It stays
 * CLOSED until there is persistent storage and someone to review IDs: only an
 * explicit PRO_SIGNUP_OPEN=true opens it. Unset (as on Render today) = closed.
 */
export const PRO_SIGNUP_OPEN = process.env.PRO_SIGNUP_OPEN === 'true';

/**
 * DEPRECATED — pro verification is now driven by the real Dojah ID+selfie
 * check in pros.controller.js (pass → verified, anything else → manual review).
 * Kept only so older tooling that reads it doesn't break; it no longer grants
 * verified status to anyone.
 */
export const AUTO_VERIFY = false;

/** Avatar colors assigned to new pros (brand palette). */
export const AVATAR_PALETTE = ['#0e7a4a', '#b0731a', '#4655c4', '#c2452f', '#7a3fa0', '#12876f', '#2f6ec2'];

/* ============ PAYMENTS / ESCROW (Paystack — Model A) ============ */

/** Server-side only. Never sent to the browser. Empty = payments disabled. */
export const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
/** Safe to expose to the frontend (used to launch checkout inline, if desired). */
export const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
export const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

/** Servora's commission in basis points. 1200 = 12%. Integer math, no floats. */
export const SERVORA_COMMISSION_BPS = parseInt(process.env.SERVORA_COMMISSION_BPS || '1200', 10);
export const CURRENCY = process.env.CURRENCY || 'NGN';

/** Used to build the post-payment callback URL. */
export const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

/** Guards the money-moving admin endpoints (release/list). Empty = locked. */
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

/* ============ OTP ENFORCEMENT CUTOFF ============ */

/**
 * The instant registration OTP became mandatory.
 *
 * Accounts created ON OR AFTER this moment MUST have otpVerified === true to
 * log in or be listed — no exceptions, and a missing/undefined flag counts as
 * NOT verified. Accounts created BEFORE it are grandfathered, because they
 * predate the feature and were never given a chance to verify.
 *
 * This replaces the previous `otpVerified !== false` test, which was unsafe:
 * it treated *any* record without the field as verified, so a new account whose
 * OTP send failed before the flag was written would have sailed straight
 * through. The rule is now positional in time and explicit, not a shape check.
 */
export const OTP_ENFORCED_FROM = new Date(
  process.env.OTP_ENFORCED_FROM || '2026-07-29T00:00:00.000Z'
).getTime();

/** True when this pro must pass OTP before login/listing. */
export function otpRequiredFor(pro) {
  const created = new Date(pro?.createdAt || 0).getTime();
  // Unparseable/absent createdAt → treat as NEW (fail closed, require OTP).
  if (!Number.isFinite(created) || created === 0) return true;
  return created >= OTP_ENFORCED_FROM;
}

/** True when this pro is allowed through the contact-verification gate. */
export function passesOtpGate(pro) {
  return !otpRequiredFor(pro) || pro?.otpVerified === true;
}

/* ============ DOJAH KYC (ID document + selfie verification) ============ */

/** Server-side only. Never sent to the browser. */
export const DOJAH_APP_ID = process.env.DOJAH_APP_ID || '';
export const DOJAH_PRIVATE_KEY = process.env.DOJAH_PRIVATE_KEY || '';
export const DOJAH_PUBLIC_KEY = process.env.DOJAH_PUBLIC_KEY || '';
/** 'sandbox' (default) hits sandbox.dojah.io; anything else hits api.dojah.io. */
export const DOJAH_ENV = process.env.DOJAH_ENV || 'sandbox';
export const DOJAH_BASE_URL = process.env.DOJAH_BASE_URL ||
  (DOJAH_ENV === 'sandbox' ? 'https://sandbox.dojah.io' : 'https://api.dojah.io');
/** True only when both credentials are present, so we can fail safe. */
export const DOJAH_CONFIGURED = Boolean(DOJAH_APP_ID && DOJAH_PRIVATE_KEY);
/**
 * Selfie↔ID match threshold (percent). Dojah returns confidence 0-100 plus its
 * own `match` boolean (true at >= 90). We require BOTH, so a borderline score
 * never auto-verifies — it goes to manual review instead.
 *
 * Defaults to 90, matching Dojah's own match cutoff. Guarded: a missing or
 * malformed value falls back to 90 rather than silently becoming NaN (which
 * would make every comparison false and block ALL auto-approvals).
 */
const DEFAULT_MATCH_THRESHOLD = 90;
function resolveMatchThreshold(raw) {
  if (raw === undefined || raw === '') return DEFAULT_MATCH_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    console.warn(`[config] DOJAH_MATCH_THRESHOLD="${raw}" is not a valid 0-100 percentage — using ${DEFAULT_MATCH_THRESHOLD}.`);
    return DEFAULT_MATCH_THRESHOLD;
  }
  if (n > 99) {
    console.warn(`[config] DOJAH_MATCH_THRESHOLD=${n} is above any realistic score — every applicant will go to manual review.`);
  }
  return n;
}
export const DOJAH_MATCH_THRESHOLD = resolveMatchThreshold(process.env.DOJAH_MATCH_THRESHOLD);

/** True only when a secret key is present, so we can fail loudly-but-safely. */
export const PAYSTACK_CONFIGURED = Boolean(PAYSTACK_SECRET_KEY);
