/**
 * Escrow transactions, their split-release stages, the append-only audit log,
 * and Paystack webhook de-duplication.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db/pool.js';
import { iso, updateSql } from './util.js';

const toStage = (s) => s && ({
  milestone: s.milestone,
  payoutKobo: s.payout_kobo,
  status: s.status,
  recipientCode: s.recipient_code,
  transferReference: s.transfer_reference,
  transferCode: s.transfer_code,
  transferredAt: iso(s.transferred_at),
  failureReason: s.failure_reason,
});

function toTx(r, stages = []) {
  if (!r) return null;
  const st = Object.fromEntries(stages.map((s) => [s.stage, s]));
  return {
    id: r.id,
    reference: r.reference,
    bookingId: r.booking_id,
    proId: r.pro_id,
    kind: r.kind,
    customer: { email: r.customer_email, phone: r.customer_phone },
    amountKobo: r.amount_kobo,
    commissionBps: r.commission_bps,
    commissionKobo: r.commission_kobo,
    proPayoutKobo: r.pro_payout_kobo,
    currency: r.currency,
    status: r.status,
    authorizationUrl: r.authorization_url,
    // Present only for quote (split-escrow) transactions — callers test `tx.split`.
    split: r.kind === 'quote' && st.stage1 ? {
      materialsKobo: r.split_materials_kobo,
      labourKobo: r.split_labour_kobo,
      inspectionKobo: r.split_inspection_kobo,
      inspectionCommissionKobo: r.split_inspection_commission_kobo,
      labourCommissionKobo: r.split_labour_commission_kobo,
      totalCommissionKobo: r.split_total_commission_kobo,
      stage1: toStage(st.stage1),
      stage2: toStage(st.stage2),
    } : undefined,
    charge: {
      chargedAt: iso(r.charged_at), channel: r.charge_channel,
      paystackFeesKobo: r.paystack_fees_kobo, verified: r.charge_verified,
    },
    payout: {
      recipientCode: r.payout_recipient_code, transferCode: r.payout_transfer_code,
      transferReference: r.payout_transfer_reference, transferredAt: iso(r.payout_transferred_at),
      failureReason: r.payout_failure_reason,
    },
    refund: {
      refundedAt: iso(r.refunded_at), reason: r.refund_reason,
      amountKobo: r.refund_amount_kobo, partial: r.refund_partial ?? undefined,
    },
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function hydrate(rows, client) {
  if (!rows.length) return [];
  const { rows: stages } = await db(client).query(
    'SELECT * FROM transaction_stages WHERE transaction_id = ANY($1::text[])', [rows.map((r) => r.id)]);
  return rows.map((r) => toTx(r, stages.filter((s) => s.transaction_id === r.id)));
}

const lock = (forUpdate) => (forUpdate ? ' FOR UPDATE' : '');

export async function getTxByReference(reference, client, { forUpdate = false } = {}) {
  const { rows } = await db(client).query(
    `SELECT * FROM transactions WHERE reference = $1${lock(forUpdate)}`, [String(reference)]);
  return (await hydrate(rows, client))[0] || null;
}

/** The booking's transaction in one of `statuses` (newest first), or null. */
export async function findBookingTx(bookingId, statuses, client, { forUpdate = false } = {}) {
  const { rows } = await db(client).query(
    `SELECT * FROM transactions WHERE booking_id = $1 AND status = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 1${lock(forUpdate)}`, [bookingId, statuses]);
  return (await hydrate(rows, client))[0] || null;
}

/** Prefer a transaction past 'pending'; fall back to any. Powers the booking timeline. */
export async function latestBookingTx(bookingId) {
  const { rows } = await db().query(
    `SELECT * FROM transactions WHERE booking_id = $1
      ORDER BY (status <> 'pending') DESC, created_at DESC LIMIT 1`, [bookingId]);
  return (await hydrate(rows))[0] || null;
}

export async function listTransactions(status) {
  const { rows } = await db().query(
    `SELECT * FROM transactions WHERE ($1::text IS NULL OR status = $1::text) ORDER BY created_at DESC`,
    [status || null]);
  return hydrate(rows);
}

/** Webhook lookup by a single-payout transfer reference or transfer code. */
export async function findTxByTransfer(client, { reference, transferCode }) {
  const { rows } = await client.query(
    `SELECT * FROM transactions
      WHERE ($1::text IS NOT NULL AND payout_transfer_reference = $1::text)
         OR ($2::text IS NOT NULL AND payout_transfer_code = $2::text)
      LIMIT 1 FOR UPDATE`, [reference || null, transferCode || null]);
  return (await hydrate(rows, client))[0] || null;
}

export async function insertTransaction(client, t) {
  const s = t.split;
  await client.query(
    `INSERT INTO transactions (id, reference, booking_id, pro_id, kind, customer_email, customer_phone,
       amount_kobo, commission_bps, commission_kobo, pro_payout_kobo, currency, status,
       split_materials_kobo, split_labour_kobo, split_inspection_kobo,
       split_inspection_commission_kobo, split_labour_commission_kobo, split_total_commission_kobo,
       created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [t.id, t.reference, t.bookingId, t.proId, t.kind, t.customer.email, t.customer.phone,
     t.amountKobo, t.commissionBps, t.commissionKobo, t.proPayoutKobo, t.currency, t.status,
     s?.materialsKobo ?? null, s?.labourKobo ?? null, s?.inspectionKobo ?? null,
     s?.inspectionCommissionKobo ?? null, s?.labourCommissionKobo ?? null,
     s?.totalCommissionKobo ?? null, t.createdAt]);
  if (s) {
    for (const key of ['stage1', 'stage2']) {
      await client.query(
        `INSERT INTO transaction_stages (transaction_id, stage, milestone, payout_kobo, status)
         VALUES ($1,$2,$3,$4,$5)`, [t.id, key, s[key].milestone, s[key].payoutKobo, s[key].status]);
    }
  }
}

// camelCase (incl. nested charge/payout/refund) → columns. Fixed list only.
const TX_FIELDS = {
  status: 'status', authorizationUrl: 'authorization_url',
  'charge.chargedAt': 'charged_at', 'charge.channel': 'charge_channel',
  'charge.paystackFeesKobo': 'paystack_fees_kobo', 'charge.verified': 'charge_verified',
  'payout.recipientCode': 'payout_recipient_code', 'payout.transferCode': 'payout_transfer_code',
  'payout.transferReference': 'payout_transfer_reference',
  'payout.transferredAt': 'payout_transferred_at', 'payout.failureReason': 'payout_failure_reason',
  'refund.refundedAt': 'refunded_at', 'refund.reason': 'refund_reason',
  'refund.amountKobo': 'refund_amount_kobo', 'refund.partial': 'refund_partial',
};

function flatten(patch) {
  const pairs = [];
  for (const [k, v] of Object.entries(patch)) {
    const nested = v && typeof v === 'object' && !Array.isArray(v) && ['charge', 'payout', 'refund'].includes(k);
    for (const [kk, vv] of nested ? Object.entries(v).map(([a, b]) => [`${k}.${a}`, b]) : [[k, v]]) {
      if (vv === undefined) continue;
      if (!TX_FIELDS[kk]) throw new Error(`transactions: field "${kk}" cannot be updated`);
      pairs.push([TX_FIELDS[kk], vv]);
    }
  }
  return pairs;
}

/** Update a transaction by id (inside the caller's transaction). */
export async function updateTx(client, id, patch) {
  const { text, params } = updateSql('transactions', flatten(patch), 'id = $1', [id]);
  await client.query(text, params);
}

/**
 * Compare-and-set on the transaction status: only moves `from` → `to` if the
 * row is still at `from`. Returns true when this caller won the race.
 */
export async function claimTxStatus(client, id, from, to, patch = {}) {
  const { text, params } = updateSql('transactions', [['status', to], ...flatten(patch)],
    'id = $1 AND status = $2', [id, from], 'id');
  const { rowCount } = await client.query(text, params);
  return rowCount === 1;
}

const STAGE_FIELDS = {
  status: 'status', recipientCode: 'recipient_code', transferReference: 'transfer_reference',
  transferCode: 'transfer_code', transferredAt: 'transferred_at', failureReason: 'failure_reason',
};

/**
 * Update one release stage. With `fromStatuses`, it is a compare-and-set:
 * returns false if the stage was not in one of those statuses.
 */
export async function updateStage(client, txId, stage, patch, { fromStatuses = null } = {}) {
  const pairs = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => {
    if (!STAGE_FIELDS[k]) throw new Error(`transaction_stages: field "${k}" cannot be updated`);
    return [STAGE_FIELDS[k], v];
  });
  const where = fromStatuses
    ? 'transaction_id = $1 AND stage = $2 AND status = ANY($3::text[])'
    : 'transaction_id = $1 AND stage = $2';
  const { text, params } = updateSql('transaction_stages', pairs, where,
    fromStatuses ? [txId, stage, fromStatuses] : [txId, stage], 'stage');
  const { rowCount } = await client.query(text, params);
  return rowCount === 1;
}

/** Append an immutable audit event (the table rejects UPDATE/DELETE). */
export async function recordEvent(client, tx, { type, fromStatus = null, toStatus = null, actor = 'system', data = {} }) {
  await client.query(
    `INSERT INTO transaction_events (id, transaction_id, reference, type, from_status, to_status, actor, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), tx.id, tx.reference, type, fromStatus, toStatus, actor, JSON.stringify(data || {})]);
}

/** Record a webhook delivery. False when it was already processed (a redelivery). */
export async function claimWebhook(client, key, event) {
  const { rowCount } = await client.query(
    'INSERT INTO processed_webhooks (key, event) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, event]);
  return rowCount === 1;
}
