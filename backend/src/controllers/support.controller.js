/**
 * Support controller — customer support messages.
 *
 * v1 stores messages in db.json so nothing is lost. Later this should
 * forward to the real support inbox (email/helpdesk/WhatsApp Business).
 */
import { randomUUID } from 'node:crypto';
import { loadDB, saveDB } from '../store/store.js';

export function createSupportMessage(req, res) {
  const { name, email, topic, message } = req.body || {};

  const missing = ['name', 'email', 'message'].filter(f => !req.body?.[f]?.toString().trim());
  if (missing.length) {
    return res.status(400).json({ ok: false, error: `Missing required fields: ${missing.join(', ')}` });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim())) {
    return res.status(400).json({ ok: false, error: 'That email address does not look valid.' });
  }

  const entry = {
    id: randomUUID(),
    name: String(name).trim(),
    email: String(email).trim(),
    topic: topic ? String(topic).trim() : 'Something else',
    message: String(message).trim().slice(0, 4000),
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  const db = loadDB();
  db.supportMessages = db.supportMessages || [];
  db.supportMessages.push(entry);
  saveDB(db);

  res.status(201).json({
    ok: true,
    ref: 'SUP-' + entry.id.replace(/-/g, '').slice(0, 6).toUpperCase(),
    message: 'Support message received — we reply within 24 hours.',
  });
}

/**
 * FUTURE: POST /api/support/chat
 * Where a real LLM-backed agent would live. Send { message, history }
 * to the model with a system prompt scoped to Servora's policies, and
 * return { reply }. The frontend already routes through askAgent(), so
 * only that function needs to change. Until then the frontend answers
 * from a local knowledge base — it can't invent a policy.
 */
