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
 * In production, registrations stay 'pending_verification' until the
 * 4-stage check (NIN/ID, skill test, guarantors, address) passes.
 * In dev/demo we auto-verify so new pros appear in listings immediately.
 */
export const AUTO_VERIFY = process.env.AUTO_VERIFY !== 'false';

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

/** True only when a secret key is present, so we can fail loudly-but-safely. */
export const PAYSTACK_CONFIGURED = Boolean(PAYSTACK_SECRET_KEY);
