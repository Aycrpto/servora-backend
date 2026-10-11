/** Bookings, their status history, and job evidence. */
import { db } from '../db/pool.js';
import { iso, pairsFrom, updateSql } from './util.js';
import { itemsFor } from './quotes.js';
import { statusLabel } from '../services/escrow.js';

const toHistory = (r) => ({ status: r.status, label: r.label, actor: r.actor, note: r.note, at: iso(r.at) });

function toBooking(r, history = [], items = []) {
  if (!r) return null;
  return {
    id: r.id,
    proId: r.pro_id,
    kind: r.kind,
    quoteId: r.quote_id ?? undefined,
    service: r.service,
    description: r.description,
    customer: { name: r.customer_name, email: r.customer_email, phone: r.customer_phone },
    agreedAmountKobo: r.agreed_amount_kobo,
    // Quote bookings carry the priced split the charge is derived from.
    breakdown: r.kind === 'quote' ? {
      materialsKobo: r.materials_kobo, labourKobo: r.labour_kobo,
      inspectionKobo: r.inspection_kobo, items,
    } : undefined,
    redoCount: r.redo_count,
    redoReason: r.redo_reason,
    status: r.status,
    history,
    startedAt: iso(r.started_at),
    readyAt: iso(r.ready_at),
    completedAt: iso(r.completed_at),
    disputeEligibleAt: iso(r.dispute_eligible_at),
    autoConfirmAt: iso(r.auto_confirm_at),
    disputedAt: iso(r.disputed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Attach history + quote items to booking rows (batched: two queries total). */
async function hydrate(rows, client) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: hist } = await db(client).query(
    'SELECT * FROM booking_history WHERE booking_id = ANY($1::text[]) ORDER BY booking_id, id', [ids]);
  const historyBy = new Map(ids.map((id) => [id, []]));
  for (const h of hist) historyBy.get(h.booking_id).push(toHistory(h));
  const items = await itemsFor(rows.filter((r) => r.quote_id).map((r) => r.quote_id), client);
  return rows.map((r) => toBooking(r, historyBy.get(r.id), items.get(r.quote_id) || []));
}

export async function getBooking(id, client, { forUpdate = false } = {}) {
  const { rows } = await db(client).query(
    `SELECT * FROM bookings WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [String(id)]);
  return (await hydrate(rows, client))[0] || null;
}

export async function listBookingsForPro(proId) {
  const { rows } = await db().query('SELECT * FROM bookings WHERE pro_id = $1 ORDER BY created_at DESC', [proId]);
  return hydrate(rows);
}

/** Append one entry to a booking's visible timeline. */
export async function addHistory(client, bookingId, status, actor = 'system', note = null) {
  await client.query(
    'INSERT INTO booking_history (booking_id, status, label, actor, note) VALUES ($1,$2,$3,$4,$5)',
    [bookingId, status, statusLabel(status), actor, note]);
}

export async function insertBooking(client, b) {
  await client.query(
    `INSERT INTO bookings (id, pro_id, kind, quote_id, service, description, customer_name,
       customer_email, customer_phone, agreed_amount_kobo, materials_kobo, labour_kobo,
       inspection_kobo, redo_count, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [b.id, b.proId, b.kind, b.quoteId ?? null, b.service, b.description, b.customer?.name ?? null,
     b.customer?.email ?? null, b.customer?.phone ?? null, b.agreedAmountKobo,
     b.breakdown?.materialsKobo ?? null, b.breakdown?.labourKobo ?? null,
     b.breakdown?.inspectionKobo ?? null, b.redoCount ?? 0, b.status, b.createdAt]);
}

const FIELDS = {
  status: 'status', redoCount: 'redo_count', redoReason: 'redo_reason', startedAt: 'started_at',
  readyAt: 'ready_at', completedAt: 'completed_at', disputeEligibleAt: 'dispute_eligible_at',
  autoConfirmAt: 'auto_confirm_at', disputedAt: 'disputed_at',
};

/**
 * Move a booking to `status` (plus any extra fields) and log it on the
 * timeline, in the caller's transaction.
 */
export async function transitionBooking(client, id, status, { actor = 'system', note = null, set = {} } = {}) {
  const { text, params } = updateSql('bookings', pairsFrom(FIELDS, { ...set, status }, 'bookings'), 'id = $1', [id]);
  await client.query(text, params);
  await addHistory(client, id, status, actor, note);
}

/** Update fields without a status change (no timeline entry). */
export async function updateBooking(client, id, set) {
  const pairs = pairsFrom(FIELDS, set, 'bookings');
  if (!pairs.length) return;
  const { text, params } = updateSql('bookings', pairs, 'id = $1', [id]);
  await client.query(text, params);
}

/** Bump updated_at (e.g. new evidence) without a status change. */
export async function touchBooking(client, id) {
  await client.query('UPDATE bookings SET updated_at = now() WHERE id = $1', [id]);
}

/* -------------------------------------------------------------- evidence */

const toEvidence = (r) => ({
  id: r.id, bookingId: r.booking_id, proId: r.pro_id, phase: r.phase,
  photos: r.photos, videos: r.videos, note: r.note, createdAt: iso(r.created_at),
});

export async function insertEvidence(client, e) {
  await client.query(
    `INSERT INTO job_evidence (id, booking_id, pro_id, phase, photos, videos, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.id, e.bookingId, e.proId, e.phase, e.photos, e.videos, e.note, e.createdAt]);
}

export async function listEvidence(bookingId) {
  const { rows } = await db().query(
    'SELECT * FROM job_evidence WHERE booking_id = $1 ORDER BY created_at', [bookingId]);
  return rows.map(toEvidence);
}

/** Photo/video totals for one phase — what the gates (/ready, /complete) check. */
export async function evidenceCounts(client, bookingId, phase) {
  const { rows } = await db(client).query(
    `SELECT COALESCE(SUM(cardinality(photos)), 0)::int AS photos,
            COALESCE(SUM(cardinality(videos)), 0)::int AS videos
       FROM job_evidence WHERE booking_id = $1 AND phase = $2`, [bookingId, phase]);
  return rows[0];
}
