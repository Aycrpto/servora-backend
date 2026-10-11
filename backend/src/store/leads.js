/** Customer job requests (leads) and support messages. */
import { db } from '../db/pool.js';
import { iso, isUuid } from './util.js';

export function toLead(r) {
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    proId: r.pro_id,
    service: r.service,
    description: r.description,
    area: r.area,
    state: r.state,
    name: r.name,
    phone: r.phone,
    email: r.email,
    when: r.preferred_time,
    status: r.status,
    quoteId: r.quote_id,
    quotedAt: iso(r.quoted_at),
    createdAt: iso(r.created_at),
  };
}

export async function insertLead(l) {
  await db().query(
    `INSERT INTO leads (id, type, pro_id, service, description, area, state, name, phone, email,
                        preferred_time, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [l.id, l.type, isUuid(l.proId) ? l.proId : null, l.service, l.description, l.area, l.state,
     l.name, l.phone, l.email, l.when, l.status, l.createdAt]);
}

/**
 * A pro's inbox: leads addressed to them, plus open job posts for EXACTLY
 * their trade (and their state, when the lead has one). Newest first.
 */
export async function leadsForPro(pro) {
  const { rows } = await db().query(
    `SELECT * FROM leads
      WHERE pro_id = $1
         OR (pro_id IS NULL AND type <> 'direct_contact' AND service = $2
             AND (state IS NULL OR state = $3))
      ORDER BY created_at DESC`, [pro.id, pro.category, pro.state]);
  return rows.map(toLead);
}

/** Mark a lead as quoted (inside the quote-creation transaction). */
export async function markLeadQuoted(client, leadId, quoteId) {
  if (!isUuid(leadId)) return;
  await client.query(
    "UPDATE leads SET status = 'quoted', quote_id = $2, quoted_at = now() WHERE id = $1",
    [leadId, quoteId]);
}

export async function insertSupportMessage(m) {
  await db().query(
    `INSERT INTO support_messages (id, name, email, topic, message, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [m.id, m.name, m.email, m.topic, m.message, m.status, m.createdAt]);
}
