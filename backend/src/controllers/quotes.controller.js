/**
 * Quotes controller — the pro-issued, itemised price a customer accepts to
 * start a split-escrow job.
 *
 * A quote breaks the price into three parts so the customer sees exactly what
 * they are paying for:
 *   • Materials — each line item priced separately (a pure pass-through to the pro)
 *   • Labour    — the workmanship fee (Servora commission applies)
 *   • Inspection/visit — optional call-out fee (Servora commission applies)
 *
 * Accepting a quote creates a "quote" booking in pending_payment; the customer
 * then pays the FULL total into escrow, which is released in two stages
 * (materials after approval, labour after completion). See escrow.js.
 */
import { randomUUID } from 'node:crypto';
import { loadDB, mutate } from '../store/store.js';
import { BOOKING_STATUS, computeQuoteSplit, pushBookingHistory } from '../services/escrow.js';
import { deliverQuote } from '../services/notifications.js';

const now = () => new Date().toISOString();
const isPosInt = (n) => Number.isInteger(n) && n > 0;
const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;
const MIN_KOBO = 10000;        // ₦100 floor
const MAX_KOBO = 500000000;    // ₦5,000,000 ceiling (fat-finger guard)

// A pro proves ownership with their demo bearer token (matches the rest of the app).
const BEARER = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/** Resolve a naira|kobo pair to integer kobo, or null if neither is a valid positive int. */
function toKobo(kobo, naira) {
  if (isPosInt(kobo)) return kobo;
  if (isPosInt(naira)) return naira * 100;
  return null;
}

/**
 * POST /api/quotes   (Pro only — Bearer demo-<proId>)
 * Body: {
 *   proId, service?, description?,
 *   customer: { name?, email?, phone? },
 *   materials?: [{ label, amountNaira? | amountKobo? }],
 *   labourNaira? | labourKobo?, labourLabel?,
 *   inspectionNaira? | inspectionKobo?,   // optional visit/call-out fee
 *   note?
 * }
 */
export async function createQuote(req, res) {
  const b = req.body || {};
  const { proId, service, description, customer, materials, labourLabel, note } = b;

  const db = loadDB();
  const pro = db.professionals.find((p) => String(p.id) === String(proId) && p.status === 'verified');
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });
  if (BEARER(req) !== 'demo-' + pro.id) {
    return res.status(403).json({ ok: false, error: 'Only the professional can issue this quote.' });
  }
  if (!customer?.email && !customer?.phone) {
    return res.status(400).json({ ok: false, error: 'Customer email or phone is required.' });
  }

  // Build the itemised breakdown. Materials are optional line items; labour and
  // inspection are single figures. All amounts validated as positive kobo.
  const items = [];
  let materialsKobo = 0;
  if (materials != null) {
    if (!Array.isArray(materials)) return res.status(400).json({ ok: false, error: 'materials must be a list.' });
    if (materials.length > 30) return res.status(400).json({ ok: false, error: 'Too many material line items (max 30).' });
    for (const m of materials) {
      const amt = toKobo(m?.amountKobo, m?.amountNaira);
      if (!amt) return res.status(400).json({ ok: false, error: 'Each material needs a valid positive amount.' });
      const label = (m?.label ?? '').toString().trim().slice(0, 120) || 'Material';
      items.push({ id: 'it_' + randomUUID().slice(0, 8), kind: 'material', label, amountKobo: amt });
      materialsKobo += amt;
    }
  }

  const labourKobo = toKobo(b.labourKobo, b.labourNaira) || 0;
  if (labourKobo > 0) {
    items.push({ id: 'it_' + randomUUID().slice(0, 8), kind: 'labour', label: (labourLabel ?? 'Labour / workmanship').toString().trim().slice(0, 120), amountKobo: labourKobo });
  }

  const inspectionKobo = toKobo(b.inspectionKobo, b.inspectionNaira) || 0;
  if (inspectionKobo > 0) {
    items.push({ id: 'it_' + randomUUID().slice(0, 8), kind: 'inspection', label: 'Inspection / visit fee', amountKobo: inspectionKobo });
  }

  const totalKobo = materialsKobo + labourKobo + inspectionKobo;
  if (!isNonNegInt(totalKobo) || totalKobo < MIN_KOBO) {
    return res.status(400).json({ ok: false, error: 'Quote total is below the ₦100 minimum.' });
  }
  if (totalKobo > MAX_KOBO) return res.status(400).json({ ok: false, error: 'Quote total exceeds the allowed maximum.' });
  // Servora earns commission on labour + inspection, so a quote must include at
  // least one of them (a pure materials pass-through is not a billable service).
  if (labourKobo + inspectionKobo <= 0) {
    return res.status(400).json({ ok: false, error: 'A quote must include a labour and/or inspection fee.' });
  }

  const quote = {
    id: 'qt_' + randomUUID().slice(0, 12),
    proId: pro.id,
    proName: pro.name,
    service: service ?? pro.category,
    description: description ? String(description).slice(0, 1000) : null,
    customer: {
      name: customer?.name ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    },
    items,
    materialsKobo,
    labourKobo,
    inspectionKobo,
    totalKobo,
    note: note ? String(note).slice(0, 500) : null,
    status: 'sent',              // sent → accepted | declined
    bookingId: null,
    createdAt: now(),
    updatedAt: now(),
    acceptedAt: null,
    declinedAt: null,
  };

  await mutate((d) => d.quotes.push(quote));

  // Auto-send to the customer (email / SMS / WhatsApp — whichever their contact
  // details and configured providers allow). Never fails the quote itself.
  let delivery = null;
  try {
    delivery = await deliverQuote(quote);
    await mutate((d) => {
      const q = d.quotes.find((x) => x.id === quote.id);
      if (q) q.delivery = delivery.channels;
    });
  } catch (err) {
    console.error('[notify] quote delivery error:', err.message);
  }

  res.status(201).json({ ok: true, quote, delivery });
}

/** GET /api/quotes/:id   (capability by id — pro/customer can view). */
export function getQuote(req, res) {
  const quote = loadDB().quotes.find((q) => q.id === req.params.id);
  if (!quote) return res.status(404).json({ ok: false, error: 'Quote not found.' });
  res.json({ ok: true, quote });
}

/** GET /api/quotes?proId=<id>   (Pro only) — the pro's issued quotes. */
export function listQuotes(req, res) {
  const { proId } = req.query;
  if (!proId) return res.status(400).json({ ok: false, error: 'proId is required.' });
  if (BEARER(req) !== 'demo-' + proId) {
    return res.status(403).json({ ok: false, error: 'Unauthorized.' });
  }
  const quotes = loadDB().quotes
    .filter((q) => String(q.proId) === String(proId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, count: quotes.length, quotes });
}

/**
 * POST /api/quotes/:id/accept   (Customer capability = knowing the quote id)
 * Turns the quote into a "quote" booking in pending_payment and returns it so
 * the customer can pay the full total into escrow. Idempotent: accepting an
 * already-accepted quote returns the existing booking.
 */
export async function acceptQuote(req, res) {
  const result = await mutate((db) => {
    const q = db.quotes.find((x) => x.id === req.params.id);
    if (!q) return { code: 404, error: 'Quote not found.' };
    if (q.status === 'declined') return { code: 409, error: 'This quote was declined.' };
    if (q.status === 'accepted' && q.bookingId) {
      const existing = db.bookings.find((x) => x.id === q.bookingId);
      if (existing) return { booking: existing, quote: q, reused: true };
    }

    const pro = db.professionals.find((p) => String(p.id) === String(q.proId));
    if (!pro) return { code: 404, error: 'Professional no longer available.' };

    const booking = {
      id: 'bk_' + randomUUID().slice(0, 12),
      proId: q.proId,
      kind: 'quote',
      quoteId: q.id,
      service: q.service,
      description: q.description,
      customer: { ...q.customer },
      agreedAmountKobo: q.totalKobo,
      // Snapshot the priced breakdown onto the booking so the charge + split are
      // derived from the booking, never from the client.
      breakdown: {
        materialsKobo: q.materialsKobo,
        labourKobo: q.labourKobo,
        inspectionKobo: q.inspectionKobo,
        items: q.items,
      },
      redoCount: 0,           // one redo allowed before Support review
      status: BOOKING_STATUS.PENDING_PAYMENT,
      history: [],
      startedAt: null,
      completedAt: null,
      autoConfirmAt: null,
      disputedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    pushBookingHistory(booking, BOOKING_STATUS.PENDING_PAYMENT, 'customer', 'Quote accepted — awaiting payment');
    db.bookings.push(booking);

    q.status = 'accepted';
    q.bookingId = booking.id;
    q.acceptedAt = now();
    q.updatedAt = now();
    return { booking, quote: q, reused: false };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.status(result.reused ? 200 : 201).json({ ok: true, booking: result.booking, quote: result.quote });
}

/** POST /api/quotes/:id/decline   (Customer capability). */
export async function declineQuote(req, res) {
  const result = await mutate((db) => {
    const q = db.quotes.find((x) => x.id === req.params.id);
    if (!q) return { code: 404, error: 'Quote not found.' };
    if (q.status === 'accepted') return { code: 409, error: 'This quote was already accepted.' };
    q.status = 'declined';
    q.declinedAt = now();
    q.updatedAt = now();
    return { quote: q };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, quote: result.quote });
}
