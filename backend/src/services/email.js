/**
 * Outbound email — Resend (https://resend.com), over its HTTP API (no SDK).
 *
 *   RESEND_API_KEY   server-side key
 *   EMAIL_FROM       e.g. "Servora <no-reply@mail.servora.ng>"; must be on a
 *                    domain verified in Resend
 *   RESEND_BASE_URL  optional override so tests can use a local stand-in
 *
 * If email isn't configured, sending FAILS — loudly in the log — and never
 * falls back to printing the message: these emails carry sign-up codes,
 * password-reset links and quote links, none of which may appear in a log.
 */
import '../config.js';   // loads backend/.env before the values below are read

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const RESEND_BASE = process.env.RESEND_BASE_URL || 'https://api.resend.com';
const TIMEOUT_MS = 15_000;

export const EMAIL_CONFIGURED = Boolean(RESEND_API_KEY && EMAIL_FROM);

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('email delivery is not configured (set RESEND_API_KEY and EMAIL_FROM)');
    this.code = 'EMAIL_NOT_CONFIGURED';
  }
}

if (!EMAIL_CONFIGURED) {
  console.error('[email] RESEND_API_KEY / EMAIL_FROM are not set: sign-up codes, password-reset ' +
    'links and quote emails cannot be sent.');
} else if (/@resend\.dev>?\s*$/i.test(EMAIL_FROM)) {
  console.warn("[email] EMAIL_FROM is Resend's test sender (resend.dev): mail only reaches the Resend account owner.");
}

/**
 * Send one email. Resolves { id } once Resend accepts it; throws otherwise.
 * Never logs the recipient's content.
 */
export async function sendEmail({ to, subject, text, html }) {
  if (!EMAIL_CONFIGURED) {
    console.error('[email] NOT SENT: email delivery is not configured.');
    throw new EmailNotConfiguredError();
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${RESEND_BASE}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`Resend unreachable (${err.name === 'AbortError' ? 'timed out' : err.message})`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Resend ${res.status}${body?.name ? ' ' + body.name : ''}`);
  return { id: body?.id || null };
}
