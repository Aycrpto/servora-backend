/**
 * Self-serve password reset for professionals.
 *
 *   request  email → (identical response for every email) → a reset link
 *            is emailed if, and only if, a professional account uses it
 *   reset    token + new password → password replaced, the token spent,
 *            every session for the account revoked
 *
 * Tokens: single use, 1 hour, only the SHA-256 stored (store/passwordResets.js).
 * Limits: per IP on the routes; per account here (3 links an hour).
 * The link carries the token in the URL FRAGMENT (#reset=…), which browsers
 * never send to a server — so it can't land in access or proxy logs. The link
 * itself is never logged.
 */
import { withTransaction } from '../db/pool.js';
import { APP_BASE_URL } from '../config.js';
import { findProByEmail, getPro, updatePro } from '../store/professionals.js';
import {
  recentResetCount, createResetToken, consumeResetToken, retireResetTokens,
} from '../store/passwordResets.js';
import { revokeAllSessions } from '../store/sessions.js';
import { hashPassword, passwordProblem } from './passwords.js';
import { loginKey, clearFailures } from './loginLockout.js';
import { maskDestination } from './otp.js';
import { sendEmail } from './email.js';

export const MAX_RESETS_PER_HOUR = 3;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Deliver the reset link by email (services/email.js → Resend). */
async function sendResetEmail({ to, name, link }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const text = [
    `Hi ${first},`,
    '',
    'We received a request to reset the password for your Servora professional account.',
    '',
    'Choose a new password here. The link works once and expires in 1 hour:',
    link,
    '',
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
    '',
    '— Servora',
    'support@servora.ng',
  ].join('\n');
  const html = `<p>Hi ${escapeHtml(first)},</p>
<p>We received a request to reset the password for your Servora professional account.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#087446;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">Choose a new password</a></p>
<p>The link works once and expires in 1 hour. If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
<p>If you didn't ask for this, you can ignore this email. Your password won't change.</p>
<p>— Servora<br><a href="mailto:support@servora.ng">support@servora.ng</a></p>`;
  try {
    await sendEmail({ to, subject: 'Reset your Servora password', text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/**
 * Handle a reset request (runs AFTER the HTTP response has been sent).
 * Returns what happened, for logs/tests only — never shown to the requester.
 */
export async function processResetRequest(email) {
  const pro = await findProByEmail(email);
  if (!pro) return { outcome: 'no_account' };

  // Count and issue under a lock on the pro's row: requests are handled after
  // the response, so rapid repeats run concurrently and must queue here, or
  // they could all pass the count before any of them is recorded.
  const issued = await withTransaction(async (c) => {
    await c.query('SELECT 1 FROM professionals WHERE id = $1 FOR UPDATE', [pro.id]);
    if (await recentResetCount(pro.id, c) >= MAX_RESETS_PER_HOUR) return null;
    return createResetToken(pro.id, c);
  });
  if (!issued) return { outcome: 'rate_limited' };
  const { token, expiresAt } = issued;
  const link = `${APP_BASE_URL}/#reset=${encodeURIComponent(token)}`;
  const delivery = await sendResetEmail({ to: pro.email, name: pro.name, link, expiresAt });
  if (!delivery.sent) {
    console.error(`[password-reset] link for ${maskDestination('email', pro.email)} NOT SENT: ${delivery.reason}`);
  }
  return { outcome: 'issued', delivered: delivery.sent };
}

/** Set a new password with a reset token. */
export async function resetPasswordWithToken(token, password) {
  const problem = passwordProblem(password);   // same rule as registration
  if (problem) return { ok: false, code: 422, field: 'password', error: problem };

  // Hash first, outside the transaction: no database connection is held
  // while scrypt runs.
  const hash = await hashPassword(password);
  const proId = await withTransaction(async (c) => {
    const id = await consumeResetToken(c, token);   // atomic: single use
    if (!id) return null;
    await updatePro(id, { password: hash }, c);
    await retireResetTokens(c, id);                  // any other outstanding links die too
    await revokeAllSessions(id, c);                  // signed out everywhere
    return id;
  });
  if (!proId) {
    return { ok: false, code: 400, error: 'This reset link is invalid or has expired. Request a new one.' };
  }

  // A sign-in lockout from earlier failed attempts shouldn't block the new password.
  const pro = await getPro(proId);
  clearFailures(loginKey(pro.phone), ...(pro.email ? [loginKey(pro.email)] : []));
  return { ok: true };
}
