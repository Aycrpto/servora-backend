/**
 * Paystack API wrapper — the ONLY module that talks to Paystack.
 * Uses Node 18+ global fetch (no axios dependency). The secret key never
 * leaves the server; it is read from config and sent as a Bearer header here.
 */
import crypto from 'node:crypto';
import { PAYSTACK_SECRET_KEY, PAYSTACK_BASE_URL, PAYSTACK_CONFIGURED, CURRENCY } from '../config.js';

export { PAYSTACK_CONFIGURED };

/** Low-level call. Throws tagged errors so controllers can map them to HTTP codes. */
async function call(pathname, { method = 'GET', body } = {}) {
  if (!PAYSTACK_CONFIGURED) {
    throw Object.assign(new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY).'),
      { code: 'PAYSTACK_NOT_CONFIGURED' });
  }
  let res;
  try {
    res = await fetch(PAYSTACK_BASE_URL + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (netErr) {
    throw Object.assign(new Error(`Paystack network error: ${netErr.message}`), { code: 'PAYSTACK_ERROR' });
  }
  let json;
  try { json = await res.json(); }
  catch { throw Object.assign(new Error(`Paystack ${pathname}: invalid response (${res.status})`), { code: 'PAYSTACK_ERROR', status: res.status }); }

  if (!res.ok || json.status === false) {
    throw Object.assign(new Error(json?.message || `Paystack ${pathname} failed (${res.status})`),
      { code: 'PAYSTACK_ERROR', status: res.status });
  }
  return json.data;
}

/* ---- Transactions (collect) ---- */

/** Model A: NO split/subaccount — the full amount lands in Servora's balance. */
export const initializeTransaction = ({ email, amountKobo, reference, callbackUrl, metadata }) =>
  call('/transaction/initialize', {
    method: 'POST',
    body: { email, amount: amountKobo, reference, currency: CURRENCY, callback_url: callbackUrl, metadata },
  });

export const verifyTransaction = (reference) =>
  call(`/transaction/verify/${encodeURIComponent(reference)}`);

/* ---- Transfers (release / payout) ---- */

/** List Nigerian banks (name + code) so the frontend can offer a picker. */
export const listBanks = () => call('/bank?currency=NGN');

/** Verify a bank account before saving a recipient — prevents misdirected payouts. */
export const resolveAccount = ({ accountNumber, bankCode }) =>
  call(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);

/** Create a durable payout target; store the returned recipient_code and reuse it. */
export const createTransferRecipient = ({ name, accountNumber, bankCode }) =>
  call('/transferrecipient', {
    method: 'POST',
    body: { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: CURRENCY },
  });

/** Release the pro's share from Servora's balance. `reference` is our idempotency key. */
export const initiateTransfer = ({ amountKobo, recipientCode, reference, reason }) =>
  call('/transfer', {
    method: 'POST',
    body: { source: 'balance', amount: amountKobo, recipient: recipientCode, reference, reason },
  });

/** Refund a charge back to the customer (used when a dispute is resolved in
 *  their favour). `transaction` accepts our original charge reference. Omit
 *  amount to refund in full. Paystack processes it asynchronously. */
export const refundTransaction = ({ reference, amountKobo }) =>
  call('/refund', {
    method: 'POST',
    body: amountKobo ? { transaction: reference, amount: amountKobo } : { transaction: reference },
  });

/* ---- Webhook security ---- */

/**
 * Verify a Paystack webhook by recomputing the HMAC-SHA512 of the RAW body
 * with the secret key and timing-safe comparing it to the x-paystack-signature
 * header. Must be given the raw bytes (not re-serialized JSON).
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!PAYSTACK_CONFIGURED || !signature) return false;
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
