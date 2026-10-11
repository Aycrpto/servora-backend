/**
 * Payments controller — Paystack escrow, Model A
 * (collect the full amount into Servora's balance, transfer the pro's share
 * out only after the job is confirmed; Servora's commission is simply retained).
 *
 * Endpoints:
 *   POST /api/payments/initialize          start a payment for a booking
 *   POST /api/payments/webhook             Paystack events (raw-body, signed)
 *   POST /api/payments/release             pay the pro after confirmation (admin)
 *   GET  /api/payments/transactions        list transactions (admin)
 *   GET  /api/payments/transactions/:ref   one transaction (admin)
 */
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { APP_BASE_URL, PAYSTACK_CONFIGURED } from '../config.js';
import { isAdmin } from '../middleware/adminAuth.js';
import * as paystack from '../services/paystack.js';
import {
  TX_STATUS, BOOKING_STATUS, computeSplit, computeQuoteSplit, genReference, canTransition,
} from '../services/escrow.js';
import { releaseEscrow } from '../services/escrowActions.js';
import { getBooking, transitionBooking } from '../store/bookings.js';
import {
  getTxByReference, findBookingTx, listTransactions as listTxRows, insertTransaction, updateTx,
  claimTxStatus, findTxByTransfer, recordEvent, claimWebhook,
} from '../store/transactions.js';
import { isUniqueViolation } from '../store/util.js';

const now = () => new Date().toISOString();
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const adminOk = (req) => isAdmin(req);   // constant-time compare, see adminAuth.js

/** Map thrown gateway errors to sensible HTTP responses (no secrets leaked). */
function gatewayError(res, err) {
  console.error('[payments]', err.code || 'ERROR', '-', err.message);
  if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
    return res.status(503).json({ ok: false, error: 'Payments are not configured on the server yet.' });
  }
  if (err.code === 'PAYSTACK_ERROR') {
    return res.status(502).json({ ok: false, error: 'Payment gateway error. Please try again.' });
  }
  throw err;   // database and other errors go to the central error handler
}

/* ============================================================
 * 1. INITIALIZE PAYMENT
 * ==========================================================*/
export async function initializePayment(req, res) {
  const { bookingId, email } = req.body || {};
  if (!bookingId) return res.status(400).json({ ok: false, error: 'bookingId is required.' });

  const booking = await getBooking(bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  if (booking.status !== BOOKING_STATUS.PENDING_PAYMENT) {
    return res.status(409).json({ ok: false, error: `Booking is not awaiting payment (status: ${booking.status}).` });
  }

  // Paystack requires an email. Prefer the booking's; fall back to the request.
  const payerEmail = (booking.customer?.email || email || '').trim();
  if (!emailRe.test(payerEmail)) {
    return res.status(400).json({ ok: false, error: 'A valid customer email is required for payment.' });
  }

  // AMOUNT IS SERVER-DERIVED from the booking — never taken from the client.
  const amountKobo = booking.agreedAmountKobo;

  // Quote bookings carry a materials/labour/inspection breakdown and pay out in
  // two escrow stages; simple bookings pay out once. Derive the split from the
  // booking (never the client) so the money math is authoritative.
  const isQuote = booking.kind === 'quote' && Boolean(booking.breakdown);
  let commissionBps, commissionKobo, proPayoutKobo, splitObj = null;
  if (isQuote) {
    const bd = booking.breakdown;
    const qs = computeQuoteSplit(bd.materialsKobo, bd.labourKobo, bd.inspectionKobo);
    commissionBps = qs.commissionBps;
    commissionKobo = qs.totalCommissionKobo;
    proPayoutKobo = qs.stage1PayoutKobo + qs.stage2PayoutKobo;
    splitObj = {
      materialsKobo: qs.materialsKobo, labourKobo: qs.labourKobo, inspectionKobo: qs.inspectionKobo,
      inspectionCommissionKobo: qs.inspectionCommissionKobo, labourCommissionKobo: qs.labourCommissionKobo,
      totalCommissionKobo: qs.totalCommissionKobo,
      stage1: { milestone: 'materials', payoutKobo: qs.stage1PayoutKobo, status: 'held' },
      stage2: { milestone: 'labour', payoutKobo: qs.stage2PayoutKobo, status: 'held' },
    };
  } else {
    ({ commissionBps, commissionKobo, proPayoutKobo } = computeSplit(amountKobo));
  }

  // Reuse the booking's still-pending transaction (idempotent). The database
  // allows only one pending transaction per booking, so a concurrent duplicate
  // request loses the insert and reuses the winner's.
  let tx = await findBookingTx(bookingId, [TX_STATUS.PENDING]);
  if (!tx) {
    const fresh = {
      id: 'txn_' + randomUUID().slice(0, 12),
      reference: genReference(),
      bookingId,
      proId: booking.proId,
      kind: isQuote ? 'quote' : 'simple',
      customer: { email: payerEmail, phone: booking.customer?.phone ?? null },
      amountKobo, commissionBps, commissionKobo, proPayoutKobo,
      currency: 'NGN',
      status: TX_STATUS.PENDING,
      split: splitObj || undefined,
      createdAt: now(),
    };
    try {
      await withTransaction(async (c) => {
        await insertTransaction(c, fresh);
        await recordEvent(c, fresh, { type: 'initialized', toStatus: TX_STATUS.PENDING, data: { amountKobo } });
      });
      tx = fresh;
    } catch (err) {
      if (!isUniqueViolation(err, 'transactions_one_pending_per_booking')) throw err;
      tx = await findBookingTx(bookingId, [TX_STATUS.PENDING]);
    }
  }
  const { reference } = tx;

  // Call Paystack — Model A sends NO split/subaccount, so 100% lands in Servora's balance.
  let initData;
  try {
    initData = await paystack.initializeTransaction({
      email: payerEmail,
      amountKobo,
      reference,
      // Land back on the single-page app; the frontend reads ?servora_pay=<ref>
      // and shows a confirming screen that polls the status endpoint below.
      callbackUrl: `${APP_BASE_URL}/?servora_pay=${encodeURIComponent(reference)}`,
      metadata: { bookingId, proId: booking.proId, txnId: tx.id },
    });
  } catch (err) {
    return gatewayError(res, err);
  }

  await withTransaction((c) => updateTx(c, tx.id, { authorizationUrl: initData.authorization_url }));

  // authorization_url is safe to return; no keys are exposed.
  res.status(201).json({
    ok: true,
    reference,
    authorizationUrl: initData.authorization_url,
    accessCode: initData.access_code,
    amountKobo,
  });
}

/* ============================================================
 * 2. WEBHOOK  (mounted with a RAW body parser in server.js)
 * ==========================================================*/
export async function paystackWebhook(req, res) {
  // req.body is a Buffer (express.raw). Verify the signature over the RAW bytes.
  const signature = req.headers['x-paystack-signature'];
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!paystack.verifyWebhookSignature(raw, signature)) {
    return res.sendStatus(401);
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.sendStatus(400); }

  // Idempotency: identical redeliveries carry the identical signature. The
  // de-dupe record and the event's effects commit together — if processing
  // fails, neither is saved and Paystack's retry is processed normally.
  try {
    await withTransaction(async (c) => {
      if (!await claimWebhook(c, String(signature), event.event)) return; // already handled
      await handleEvent(c, event);
    });
  } catch (err) {
    console.error('[payments] webhook processing failed:', err.message);
    return res.sendStatus(500);   // Paystack retries
  }

  // Ack once verified + recorded, so Paystack stops retrying.
  res.sendStatus(200);
}

/** Route a verified Paystack event to its handler (all inside the webhook's transaction). */
async function handleEvent(c, event) {
  const data = event.data || {};
  switch (event.event) {
    case 'charge.success': return applyChargeSuccess(c, data, 'webhook');
    case 'transfer.success': return onTransferSuccess(c, data);
    case 'transfer.failed':
    case 'transfer.reversed': return onTransferFailed(c, data, event.event);
    default: return; // ignore unrelated events
  }
}

const koboOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);

/**
 * Promote a PENDING transaction to IN_ESCROW from a successful charge.
 * Shared by the webhook (source of truth) and the status endpoint's
 * verify-on-return backstop. Idempotent + amount-guarded, so calling it
 * twice (webhook + return) is safe. `data` is a Paystack charge/verify object.
 * Runs inside the caller's transaction `c`.
 */
export async function applyChargeSuccess(c, data, actor = 'webhook') {
  const tx = await getTxByReference(data.reference, c, { forUpdate: true });
  if (!tx || tx.status !== TX_STATUS.PENDING) return; // unknown or already handled

  // Re-verify the amount: never trust that what was paid equals what we expected.
  if (Number(data.amount) !== tx.amountKobo) {
    await recordEvent(c, tx, {
      type: 'amount_mismatch', actor,
      data: { expected: tx.amountKobo, paid: Number(data.amount) },
    });
    return; // do NOT move to escrow on a mismatch — flag for manual review
  }
  if (!canTransition(tx.status, TX_STATUS.IN_ESCROW)) return;

  await updateTx(c, tx.id, {
    status: TX_STATUS.IN_ESCROW,
    charge: { chargedAt: now(), channel: data.channel ?? null, paystackFeesKobo: koboOrNull(data.fees), verified: true },
  });
  await recordEvent(c, tx, { type: 'charge_success', fromStatus: TX_STATUS.PENDING, toStatus: TX_STATUS.IN_ESCROW, actor, data: { channel: data.channel } });

  const booking = await getBooking(tx.bookingId, c, { forUpdate: true });
  if (booking && booking.status === BOOKING_STATUS.PENDING_PAYMENT) {
    await transitionBooking(c, booking.id, BOOKING_STATUS.FUNDED,
      { actor: 'customer', note: 'Payment received — held in escrow' });
  }
}

async function onTransferSuccess(c, data) {
  const tx = await findTxByTransfer(c, { reference: data.reference, transferCode: data.transfer_code });
  if (!tx) return;
  if (!await claimTxStatus(c, tx.id, TX_STATUS.RELEASE_PENDING, TX_STATUS.RELEASED, { payout: { transferredAt: now() } })) return;
  await recordEvent(c, tx, { type: 'transfer_success', fromStatus: TX_STATUS.RELEASE_PENDING, toStatus: TX_STATUS.RELEASED, actor: 'webhook' });
  await transitionBooking(c, tx.bookingId, BOOKING_STATUS.CLOSED, { actor: 'system', note: 'Payment released to professional' });
}

async function onTransferFailed(c, data, eventType) {
  const tx = await findTxByTransfer(c, { reference: data.reference, transferCode: data.transfer_code });
  if (!tx) return;
  const reason = data.reason || eventType;
  if (!await claimTxStatus(c, tx.id, TX_STATUS.RELEASE_PENDING, TX_STATUS.RELEASE_FAILED, { payout: { failureReason: reason } })) return;
  await recordEvent(c, tx, { type: 'transfer_failed', fromStatus: TX_STATUS.RELEASE_PENDING, toStatus: TX_STATUS.RELEASE_FAILED, actor: 'webhook', data: { reason } });
}

/* ============================================================
 * 2b. PAYMENT STATUS  (public, by reference — for the return screen)
 * ==========================================================*/
/**
 * GET /api/payments/status/:reference
 * The reference is an unguessable capability token, so this is safe to expose
 * read-only. Returns minimal status (no PII). If the charge is still PENDING,
 * it verifies directly with Paystack as a backstop for the webhook (which
 * cannot reach localhost in dev) — this is what confirms the payment on return.
 */
export async function getPaymentStatus(req, res) {
  const { reference } = req.params;
  let tx = await getTxByReference(reference);
  if (!tx) return res.status(404).json({ ok: false, error: 'Transaction not found.' });

  if (tx.status === TX_STATUS.PENDING && PAYSTACK_CONFIGURED) {
    try {
      const verified = await paystack.verifyTransaction(reference);
      if (verified && verified.status === 'success') {
        await withTransaction((c) => applyChargeSuccess(c, verified, 'verify')); // idempotent + guarded
        tx = await getTxByReference(reference);
      }
    } catch (err) {
      // Leave as pending; the webhook may still confirm it. Don't fail the poll.
      console.error('[payments] verify-on-return', err.code || 'ERROR', '-', err.message);
    }
  }

  const booking = await getBooking(tx.bookingId);
  res.json({
    ok: true,
    reference: tx.reference,
    status: tx.status,                 // pending | in_escrow | released | …
    amountKobo: tx.amountKobo,
    bookingId: tx.bookingId,
    bookingStatus: booking?.status ?? null,
    paid: tx.status !== TX_STATUS.PENDING && tx.status !== TX_STATUS.FAILED,
  });
}

/* ============================================================
 * 3. RELEASE FUNDS  (admin — manual/fallback payout to the pro)
 *    The happy path auto-releases on customer confirmation; this endpoint is
 *    the admin fallback (e.g. after a failed auto-release, or a dispute).
 *    Money logic lives in the shared releaseEscrow() service.
 * ==========================================================*/
export async function releaseFunds(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });

  const { reference, bookingId } = req.body || {};
  let ref = reference;
  if (!ref && bookingId) {
    const tx = await findBookingTx(bookingId, [TX_STATUS.IN_ESCROW]);
    ref = tx?.reference;
  }
  if (!ref) return res.status(400).json({ ok: false, error: 'reference or bookingId is required.' });

  const out = await releaseEscrow(ref, 'admin');
  if (!out.ok) return res.status(out.code || 502).json({ ok: false, error: out.error });
  res.json({ ok: true, ...out });
}

/* ============================================================
 * 4. ADMIN READ ENDPOINTS (for testing / a future dashboard)
 * ==========================================================*/
export async function listTransactions(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const transactions = await listTxRows(req.query.status);
  res.json({ ok: true, count: transactions.length, transactions });
}

export async function getTransaction(req, res) {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const tx = await getTxByReference(req.params.reference);
  if (!tx) return res.status(404).json({ ok: false, error: 'Transaction not found.' });
  res.json({ ok: true, transaction: tx });
}

/** GET /api/payments/banks — Nigerian bank list (name + code) for the payout picker. */
export async function listBanks(_req, res) {
  try {
    const banks = await paystack.listBanks();
    res.json({ ok: true, banks: banks.map((b) => ({ name: b.name, code: b.code })) });
  } catch (err) {
    return gatewayError(res, err);
  }
}
