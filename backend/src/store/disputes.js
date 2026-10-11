/** Disputes, Support's evidence requests, and the customer's evidence. */
import { db } from '../db/pool.js';
import { iso, isUniqueViolation } from './util.js';

function toDispute(r, requests = [], evidence = []) {
  if (!r) return null;
  return {
    id: r.id,
    bookingId: r.booking_id,
    transactionId: r.transaction_id,
    reference: r.reference,
    amountKobo: r.amount_kobo,
    service: r.service,
    kind: r.kind,
    openedBy: r.opened_by,
    reason: r.reason,
    status: r.status,
    evidenceRequests: requests.map((q) => ({ note: q.note, at: iso(q.created_at) })),
    evidence: evidence.map((e) => ({ text: e.text, photos: e.photos, at: iso(e.created_at) })),
    resolution: r.resolution_decision ? {
      decision: r.resolution_decision, reason: r.resolution_reason, by: r.resolved_by, at: iso(r.resolved_at),
    } : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function hydrate(rows, client) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [{ rows: reqs }, { rows: ev }] = await Promise.all([
    db(client).query('SELECT * FROM dispute_evidence_requests WHERE dispute_id = ANY($1::text[]) ORDER BY id', [ids]),
    db(client).query('SELECT * FROM dispute_evidence WHERE dispute_id = ANY($1::text[]) ORDER BY id', [ids]),
  ]);
  return rows.map((r) => toDispute(r,
    reqs.filter((q) => q.dispute_id === r.id), ev.filter((e) => e.dispute_id === r.id)));
}

export async function listDisputes(status) {
  const { rows } = await db().query(
    'SELECT * FROM disputes WHERE ($1::text IS NULL OR status = $1::text) ORDER BY created_at DESC',
    [status || null]);
  return hydrate(rows);
}

export async function getDispute(id, client, { forUpdate = false } = {}) {
  const { rows } = await db(client).query(
    `SELECT * FROM disputes WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [String(id)]);
  return (await hydrate(rows, client))[0] || null;
}

/** Open a dispute. Returns false if the booking already has an unresolved one. */
export async function insertDispute(client, d) {
  try {
    await client.query('SAVEPOINT open_dispute');
    await client.query(
      `INSERT INTO disputes (id, booking_id, transaction_id, reference, amount_kobo, service, kind,
         opened_by, reason, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [d.id, d.bookingId, d.transactionId, d.reference, d.amountKobo, d.service, d.kind,
       d.openedBy, d.reason, d.status, d.createdAt]);
    await client.query('RELEASE SAVEPOINT open_dispute');
    return true;
  } catch (err) {
    if (!isUniqueViolation(err, 'disputes_one_open_per_booking')) throw err;
    await client.query('ROLLBACK TO SAVEPOINT open_dispute');
    return false;
  }
}

export async function addEvidenceRequest(client, id, note) {
  await client.query('INSERT INTO dispute_evidence_requests (dispute_id, note) VALUES ($1, $2)', [id, note]);
  await client.query("UPDATE disputes SET status = 'evidence_requested' WHERE id = $1", [id]);
}

export async function addDisputeEvidence(client, id, { text, photos }) {
  await client.query('INSERT INTO dispute_evidence (dispute_id, text, photos) VALUES ($1, $2, $3)', [id, text, photos]);
  await client.query('UPDATE disputes SET updated_at = now() WHERE id = $1', [id]);
}

/** Mark resolved — only if not already resolved. Returns true if this call resolved it. */
export async function resolveDisputeRow(id, { decision, reason, by }) {
  const { rowCount } = await db().query(
    `UPDATE disputes SET status = 'resolved', resolution_decision = $2, resolution_reason = $3,
            resolved_by = $4, resolved_at = now()
      WHERE id = $1 AND status <> 'resolved'`, [id, decision, reason, by]);
  return rowCount === 1;
}
