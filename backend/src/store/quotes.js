/** Pro-issued itemised quotes and their line items. */
import { db } from '../db/pool.js';
import { iso } from './util.js';

const toItem = (r) => ({ id: r.id, kind: r.kind, label: r.label, amountKobo: r.amount_kobo });

function toQuote(r, items) {
  if (!r) return null;
  return {
    id: r.id,
    proId: r.pro_id,
    proName: r.pro_name,
    service: r.service,
    description: r.description,
    customer: { name: r.customer_name, email: r.customer_email, phone: r.customer_phone },
    items,
    materialsKobo: r.materials_kobo,
    labourKobo: r.labour_kobo,
    inspectionKobo: r.inspection_kobo,
    totalKobo: r.total_kobo,
    note: r.note,
    status: r.status,
    bookingId: r.booking_id ?? null,
    delivery: r.delivery ?? undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    acceptedAt: iso(r.accepted_at),
    declinedAt: iso(r.declined_at),
  };
}

/** Line items for one or more quotes, in their original order. */
export async function itemsFor(quoteIds, client) {
  if (!quoteIds.length) return new Map();
  const { rows } = await db(client).query(
    'SELECT * FROM quote_items WHERE quote_id = ANY($1::text[]) ORDER BY quote_id, position', [quoteIds]);
  const byQuote = new Map(quoteIds.map((id) => [id, []]));
  for (const r of rows) byQuote.get(r.quote_id).push(toItem(r));
  return byQuote;
}

// bookingId is derived from bookings.quote_id (one booking per quote).
const SELECT = `SELECT q.*, b.id AS booking_id FROM quotes q LEFT JOIN bookings b ON b.quote_id = q.id`;

export async function getQuote(id, client, { forUpdate = false } = {}) {
  const { rows } = await db(client).query(
    `${SELECT} WHERE q.id = $1${forUpdate ? ' FOR UPDATE OF q' : ''}`, [String(id)]);
  if (!rows[0]) return null;
  const items = await itemsFor([rows[0].id], client);
  return toQuote(rows[0], items.get(rows[0].id));
}

export async function listQuotesForPro(proId) {
  const { rows } = await db().query(`${SELECT} WHERE q.pro_id = $1 ORDER BY q.created_at DESC`, [proId]);
  const items = await itemsFor(rows.map((r) => r.id));
  return rows.map((r) => toQuote(r, items.get(r.id)));
}

export async function insertQuote(client, q) {
  await client.query(
    `INSERT INTO quotes (id, pro_id, pro_name, service, description, customer_name, customer_email,
       customer_phone, materials_kobo, labour_kobo, inspection_kobo, total_kobo, note, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [q.id, q.proId, q.proName, q.service, q.description, q.customer.name, q.customer.email,
     q.customer.phone, q.materialsKobo, q.labourKobo, q.inspectionKobo, q.totalKobo, q.note,
     q.status, q.createdAt]);
  for (const [i, it] of q.items.entries()) {
    await client.query(
      'INSERT INTO quote_items (id, quote_id, position, kind, label, amount_kobo) VALUES ($1,$2,$3,$4,$5,$6)',
      [it.id, q.id, i, it.kind, it.label, it.amountKobo]);
  }
}

/** Record how the quote was delivered (email/SMS results). */
export async function setQuoteDelivery(id, channels) {
  await db().query('UPDATE quotes SET delivery = $2 WHERE id = $1', [id, JSON.stringify(channels ?? null)]);
}

export async function setQuoteStatus(client, id, status) {
  const stamp = status === 'accepted' ? 'accepted_at' : 'declined_at';   // fixed column names only
  await client.query(`UPDATE quotes SET status = $2, ${stamp} = now() WHERE id = $1`, [id, status]);
}
