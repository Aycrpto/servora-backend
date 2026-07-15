/**
 * Professionals controller — listing, featured placement, registration.
 * The response shapes here are the contract the frontend's ServoraAPI maps from.
 */
import { randomUUID } from 'node:crypto';
import { loadDB, saveDB } from '../store/store.js';
import { persistPortfolio, deleteStored } from '../store/uploads.js';
import { AUTO_VERIFY, AVATAR_PALETTE } from '../config.js';

const TIER_RANK = { elite: 0, pro: 1, starter: 2 };

/** Title-case free-text places ("ikeja" → "Ikeja"), preserving short acronyms (GRA, VI). */
const titleCase = s => String(s || '').trim().replace(/\s+/g, ' ').split(' ')
  .map(w => /^[A-Z0-9]{2,4}$/.test(w) ? w : (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
  .join(' ');

/** Public listing shape — never expose credentials or private contact data. */
const publicPro = ({ password, phone, email, idDocument, ...rest }) => rest;

/** Compare phone numbers by their last 10 digits (0803… === +234803…). */
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);

const SORTERS = {
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
  resp:   (a, b) => (a.responseMins ?? 999) - (b.responseMins ?? 999),
  price:  (a, b) => (a.priceFrom ?? Number.MAX_SAFE_INTEGER) - (b.priceFrom ?? Number.MAX_SAFE_INTEGER),
  jobs:   (a, b) => (b.jobsDone ?? 0) - (a.jobsDone ?? 0),
};

/**
 * GET /api/pros?category=&state=&sort=
 * Only verified pros are listed. If the requested state has no pros yet,
 * falls back to nationwide results with stateCovered:false so the UI can
 * say "no pros in X yet — showing top pros nationwide".
 * Ranking rule: sort key first, then subscription tier (Elite > Pro > Starter).
 */
export function listPros(req, res) {
  const { category, state, sort = 'rating' } = req.query;
  let pros = loadDB().professionals.filter(p => p.status === 'verified');

  if (category) pros = pros.filter(p => p.category === category);

  const inState = state ? pros.filter(p => p.state === state) : pros;
  const stateCovered = Boolean(state) && inState.length > 0;
  if (stateCovered) pros = inState;

  const sorter = SORTERS[sort] || SORTERS.rating;
  pros.sort((a, b) => sorter(a, b) || TIER_RANK[a.tier] - TIER_RANK[b.tier]);

  res.json({ pros: pros.map(publicPro), stateCovered });
}

/**
 * GET /api/pros/featured
 * Paid placement: Elite subscribers first, then Pro, ranked by rating.
 */
export function featuredPros(_req, res) {
  const pros = loadDB().professionals
    .filter(p => p.status === 'verified' && p.tier !== 'starter')
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 8);
  res.json({ pros: pros.map(publicPro) });
}

/**
 * GET /api/pros/:id/leads
 * A professional's lead inbox: leads addressed to them directly, plus
 * open job posts matching their trade and state.
 * NOTE: no auth yet — the frontend uses a demo profile picker. When
 * auth lands (WhatsApp OTP), this route gets an ownership check.
 */
export function proLeads(req, res) {
  const db = loadDB();
  const pro = db.professionals.find(p => String(p.id) === String(req.params.id));
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found' });

  const leads = db.leads.filter(l =>
    (l.proId && String(l.proId) === String(pro.id)) ||
    (l.type !== 'direct_contact' &&
      (!l.service || l.service === pro.category) &&
      (!l.state || l.state === pro.state))
  ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    pro: { id: pro.id, name: pro.name, category: pro.category, state: pro.state },
    leads,
  });
}

/**
 * PATCH /api/pros/:id
 * A professional updates their own editable profile fields from the
 * dashboard: bio, responseMins, priceFrom. Demo auth: the bearer token
 * is "demo-<proId>" (issued at login) and must match the target id.
 * FUTURE: verify a real JWT and its subject claim.
 */
export function updatePro(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token !== 'demo-' + req.params.id) {
    return res.status(403).json({ ok: false, error: 'Not authorised to edit this profile.' });
  }

  const db = loadDB();
  const pro = db.professionals.find(p => String(p.id) === String(req.params.id));
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found' });

  const { bio, responseMins, priceFrom, portfolio } = req.body || {};

  // Portfolio: the array IS the desired final state. New data URLs are
  // written to disk, kept URLs pass through, and files no longer listed
  // are deleted so removed photos don't linger on the server.
  if (portfolio !== undefined) {
    const next = persistPortfolio(portfolio);
    (pro.portfolio || []).forEach(old => {
      const url = typeof old === 'string' ? old : old?.url;
      if (url && !next.includes(url)) deleteStored(url);
    });
    pro.portfolio = next;
  }

  if (bio !== undefined) pro.bio = bio ? String(bio).trim().slice(0, 300) : pro.bio;
  if (responseMins !== undefined) {
    const n = Number(responseMins);
    if (Number.isFinite(n) && n >= 1 && n <= 720) pro.responseMins = Math.round(n);
  }
  if (priceFrom !== undefined) {
    const n = Number(priceFrom);
    if (Number.isFinite(n) && n >= 0) {
      pro.priceFrom = Math.round(n);
      pro.priceLabel = n > 0 ? '₦' + Math.round(n).toLocaleString('en-NG') : 'Quote on request';
    }
  }

  saveDB(db);
  res.json({ ok: true, pro: publicPro(pro) });
}

/**
 * POST /api/pros/register
 * Body: { name, phone, trade, state, lga, plan, idFileName, idFileSizeKB }
 * The ID upload is simulated for v1 — we store the file metadata only.
 * Real implementation: multipart upload (multer) to object storage,
 * then a verification queue flips status to 'verified'.
 */
export function registerPro(req, res) {
  const { name, phone, email, trade, state, lga, plan, idFileName, idFileSizeKB, portfolio, password } = req.body || {};

  const missing = ['name', 'phone', 'trade', 'state'].filter(f => !req.body?.[f]?.toString().trim());
  if (missing.length) {
    return res.status(400).json({ ok: false, error: `Missing required fields: ${missing.join(', ')}` });
  }

  const db = loadDB();
  const cleanEmail = email?.toString().trim().toLowerCase() || null;

  // One account per phone / email. Checked server-side: it owns the data,
  // so this holds even if a client skips its own validation.
  const phoneTaken = db.professionals.some(p => normPhone(p.phone) === normPhone(phone));
  if (phoneTaken) {
    return res.status(409).json({ ok: false, field: 'phone', error: 'This phone number is already registered. Try signing in instead.' });
  }
  if (cleanEmail && db.professionals.some(p => p.email && String(p.email).toLowerCase() === cleanEmail)) {
    return res.status(409).json({ ok: false, field: 'email', error: 'This email is already in use. Try signing in instead.' });
  }

  // Location fields: lga holds the title-cased LGA, city holds the state —
  // the UI displays "LGA, State" (never "Ikeja, Ikeja").
  const cleanLga = lga?.toString().trim() ? titleCase(lga) : null;

  const pro = {
    id: randomUUID(),
    name: name.trim(),
    phone: phone.trim(),
    email: cleanEmail,
    category: trade,
    state,
    lga: cleanLga,
    area: cleanLga || state,
    city: state,
    rating: null,          // earned job by job
    jobsDone: 0,
    priceFrom: null,
    priceLabel: 'Quote on request',
    responseMins: 20,
    avatarColor: AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)],
    badges: ['v'],
    tier: (plan || 'Starter').toLowerCase(),
    // DEMO ONLY: plain-text password (null → shared demo password on login).
    // FUTURE: bcrypt hash here, never store the raw value.
    password: password?.toString().trim() || null,
    bio: `New on Servora — ID-verified ${trade.replace(/s$/, '').toLowerCase()} serving ${cleanLga ? cleanLga + ', ' : ''}${state}.`,
    review: null,
    skills: null,
    status: AUTO_VERIFY ? 'verified' : 'pending_verification',
    idDocument: idFileName ? { fileName: idFileName, sizeKB: idFileSizeKB ?? null, note: 'simulated upload — metadata only' } : null,
    // Optional past-work photos (max 5) — written to /uploads, stored as URLs
    portfolio: persistPortfolio(portfolio),
    createdAt: new Date().toISOString(),
  };

  db.professionals.push(pro);
  saveDB(db);

  res.status(201).json({
    ok: true,
    status: pro.status,
    pro: publicPro(pro),
    message: AUTO_VERIFY
      ? 'Auto-verified (demo mode) — your profile is live in listings now.'
      : 'Application received — verification takes ~48 hours.',
  });
}
