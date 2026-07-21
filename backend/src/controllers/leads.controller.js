/**
 * Leads controller — customer job requests.
 * Customers never need an account: a lead is just the job + a phone number.
 * Future: route the lead to matching pros (category + state) via WhatsApp/SMS.
 */
import { randomUUID } from 'node:crypto';
import { loadDB, saveDB } from '../store/store.js';

export function createLead(req, res) {
  const { type, proId, service, description, area, name, phone, email, when, state } = req.body || {};

  if (!description?.toString().trim() && !service) {
    return res.status(400).json({ ok: false, error: 'Tell us what you need done (description or service).' });
  }

  const lead = {
    id: randomUUID(),
    type: type || 'job_post',        // 'direct_contact' targets one pro, 'job_post' fans out
    proId: proId ?? null,
    service: service ?? null,
    description: description ?? null,
    area: area ?? null,
    state: state ?? null,
    name: name ?? null,
    phone: phone ?? null,
    email: email ?? null,
    when: when ?? null,
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  const db = loadDB();
  db.leads.push(lead);
  saveDB(db);

  res.status(201).json({ ok: true, id: lead.id, message: 'Lead captured — matching pros will be notified.' });
}
