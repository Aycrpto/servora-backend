/**
 * Notifications — automatic quote delivery to customers.
 *
 * Channels (each enabled by env vars, zero new dependencies — plain fetch):
 *   email    → Resend      (RESEND_API_KEY + EMAIL_FROM)
 *   sms      → Termii      (TERMII_API_KEY + TERMII_SENDER_ID)
 *   whatsapp → Termii      (same keys, whatsapp channel)
 *
 * A channel with no provider configured is NOT sent and reports status
 * 'not_configured' (with an error in the server log). The message is never
 * printed — it carries the quote link. The API response still returns the
 * composed message to the pro, so they can one-tap share it via wa.me / sms: /
 * mailto:. Delivery never fails the quote: every send is caught and reported.
 */
import { APP_BASE_URL } from '../config.js';
import { sendEmail as sendViaResend, EMAIL_CONFIGURED } from './email.js';

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

/**
 * Click-to-WhatsApp link to the PRO, pre-filled so the customer can reply in
 * one tap. Built from the pro's own number (passed in by the caller), not the
 * customer's. Returns null when we have no usable number for them.
 */
export function waLink(proPhone, text = 'Hi, I saw your quote on Servora') {
  const n = intlPhone(proPhone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

/** Compose the quote message once — every channel sends the same content. */
export function composeQuoteMessage(quote, proPhone = null) {
  const link = `${APP_BASE_URL}/?servora_quote=${encodeURIComponent(quote.id)}`;
  const service = String(quote.service || '').replace(/s$/, '');
  const mats = (quote.items || []).filter((i) => i.kind === 'material');
  const chat = waLink(proPhone);
  const lines = [
    `${quote.proName} sent you a quote on Servora — ${service}${quote.description ? ': ' + quote.description : ''}`,
    '',
    ...(mats.length ? ['Materials:', ...mats.map((m) => `• ${m.label} — ${naira(m.amountKobo)}`)] : []),
    ...(quote.inspectionKobo ? [`Inspection / visit — ${naira(quote.inspectionKobo)}`] : []),
    ...(quote.labourKobo ? [`Labour / workmanship — ${naira(quote.labourKobo)}`] : []),
    '',
    `TOTAL: ${naira(quote.totalKobo)}`,
    '',
    'Review and accept it here. Your payment is held in escrow and released only at the stages you approve:',
    link,
    ...(chat ? ['', `Chat with ${quote.proName.split(' ')[0]} on WhatsApp:`, chat] : []),
  ];
  return {
    subject: `Your ${service} quote from ${quote.proName} — ${naira(quote.totalKobo)}`,
    text: lines.join('\n'), link, waLink: chat,
  };
}

async function sendEmail(to, { subject, text }) {
  if (!EMAIL_CONFIGURED) return { channel: 'email', to, status: 'not_configured' };
  await sendViaResend({ to, subject, text });
  return { channel: 'email', to, status: 'sent' };
}

async function sendTermii(channel, to, { text }) {
  if (!TERMII_API_KEY) return { channel, to, status: 'not_configured' };
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
 * 'sent' (provider accepted), 'not_configured' (no provider set up), 'failed',
 * or 'skipped' (no address/number for that channel).
 */
export async function deliverQuote(quote, proPhone = null) {
  const message = composeQuoteMessage(quote, proPhone);
  const email = quote.customer?.email || null;
  const phone = intlPhone(quote.customer?.phone);

  // Email and SMS both go out whenever we have the address/number. A customer
  // who left only an email simply gets no SMS — the WhatsApp link is embedded
  // in the message body itself, so it reaches them either way.
  const attempts = [
    email ? sendEmail(email, message) : Promise.resolve({ channel: 'email', to: null, status: 'skipped' }),
    phone ? sendTermii('sms', phone, message) : Promise.resolve({ channel: 'sms', to: null, status: 'skipped' }),
  ];
  const channels = (await Promise.allSettled(attempts)).map((r, i) =>
    r.status === 'fulfilled' ? r.value
      : { channel: ['email', 'sms'][i], to: null, status: 'failed', error: r.reason?.message });

  // Report what didn't go out — never the message, link or recipient.
  const unsent = channels.filter((c) => c.status === 'not_configured' || c.status === 'failed');
  if (unsent.length) {
    console.error(`[notify] quote not delivered by ${unsent.map((c) => `${c.channel} (${c.error || c.status})`).join(', ')}`);
  }
  return { channels, message };
}
