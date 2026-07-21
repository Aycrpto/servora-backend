/**
 * Notifications — automatic quote delivery to customers.
 *
 * Channels (each enabled by env vars, zero new dependencies — plain fetch):
 *   email    → Resend      (RESEND_API_KEY + EMAIL_FROM)
 *   sms      → Termii      (TERMII_API_KEY + TERMII_SENDER_ID)
 *   whatsapp → Termii      (same keys, whatsapp channel)
 *
 * With no provider configured, the composed message is LOGGED and the channel
 * reports status 'logged' — the API response still tells the frontend exactly
 * what was composed, so the pro can one-tap share it via wa.me / sms: / mailto:.
 * Delivery must never fail the quote: every send is caught and reported.
 */
import { APP_BASE_URL } from '../config.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Servora <quotes@servora.ng>';
const TERMII_API_KEY = process.env.TERMII_API_KEY || '';
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || 'Servora';
const TERMII_BASE = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com';

const naira = (k) => '₦' + Math.round((k || 0) / 100).toLocaleString('en-NG');

/** Nigerian phone → international digits (0803… → 2348…); null if unusable. */
export function intlPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (/^0[789][01]\d{8}$/.test(d)) return '234' + d.slice(1);
  if (/^234[789][01]\d{8}$/.test(d)) return d;
  return d.length >= 10 ? d : null;
}

/** Compose the quote message once — every channel sends the same content. */
export function composeQuoteMessage(quote) {
  const link = `${APP_BASE_URL}/?servora_quote=${encodeURIComponent(quote.id)}`;
  const service = String(quote.service || '').replace(/s$/, '');
  const mats = (quote.items || []).filter((i) => i.kind === 'material');
  const lines = [
    `${quote.proName} sent you a quote on Servora — ${service}${quote.description ? ': ' + quote.description : ''}`,
    '',
    ...(mats.length ? ['Materials:', ...mats.map((m) => `• ${m.label} — ${naira(m.amountKobo)}`)] : []),
    ...(quote.inspectionKobo ? [`Inspection / visit — ${naira(quote.inspectionKobo)}`] : []),
    ...(quote.labourKobo ? [`Labour / workmanship — ${naira(quote.labourKobo)}`] : []),
    '',
    `TOTAL: ${naira(quote.totalKobo)}`,
    '',
    'Review and accept securely (escrow-protected — pay only when satisfied):',
    link,
  ];
  return { subject: `Your ${service} quote from ${quote.proName} — ${naira(quote.totalKobo)}`, text: lines.join('\n'), link };
}

async function sendEmail(to, { subject, text }) {
  if (!RESEND_API_KEY) return { channel: 'email', to, status: 'logged' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
  return { channel: 'email', to, status: 'sent' };
}

async function sendTermii(channel, to, { text }) {
  if (!TERMII_API_KEY) return { channel, to, status: 'logged' };
  const r = await fetch(`${TERMII_BASE}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TERMII_API_KEY, to, from: TERMII_SENDER_ID, sms: text,
      type: 'plain', channel: channel === 'whatsapp' ? 'whatsapp' : 'generic',
    }),
  });
  if (!r.ok) throw new Error(`Termii ${r.status}`);
  return { channel, to, status: 'sent' };
}

/**
 * Deliver a quote on every channel the customer's contact details allow.
 * Returns { channels: [{channel,to,status}], message } — statuses are
 * 'sent' (provider accepted), 'logged' (no provider configured — composed
 * message logged for the share buttons), 'failed', or 'skipped'.
 */
export async function deliverQuote(quote) {
  const message = composeQuoteMessage(quote);
  const email = quote.customer?.email || null;
  const phone = intlPhone(quote.customer?.phone);

  const attempts = [
    email ? sendEmail(email, message) : Promise.resolve({ channel: 'email', to: null, status: 'skipped' }),
    phone ? sendTermii('sms', phone, message) : Promise.resolve({ channel: 'sms', to: null, status: 'skipped' }),
    phone ? sendTermii('whatsapp', phone, message) : Promise.resolve({ channel: 'whatsapp', to: null, status: 'skipped' }),
  ];
  const channels = (await Promise.allSettled(attempts)).map((r, i) =>
    r.status === 'fulfilled' ? r.value
      : { channel: ['email', 'sms', 'whatsapp'][i], to: null, status: 'failed', error: r.reason?.message });

  if (channels.some((c) => c.status === 'logged')) {
    console.log(`[notify] quote ${quote.id} composed for ${email || ''} ${phone || ''}:\n${message.text}`);
  }
  return { channels, message };
}
