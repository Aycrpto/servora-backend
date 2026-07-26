/**
 * Professionals controller — listing, featured placement, registration.
 * The response shapes here are the contract the frontend's ServoraAPI maps from.
 */
import { randomUUID } from 'node:crypto';
import { loadDB, saveDB, mutate } from '../store/store.js';
import { persistPortfolio, deleteStored } from '../store/uploads.js';
import { saveKycImage } from '../store/kycStore.js';
import * as paystack from '../services/paystack.js';
import { hashPassword } from '../services/passwords.js';
import { verifyPhotoIdWithSelfie } from '../services/dojah.js';
import { AVATAR_PALETTE } from '../config.js';

const TIER_RANK = { elite: 0, pro: 1, starter: 2 };

/** Title-case free-text places ("ikeja" → "Ikeja"), preserving short acronyms (GRA, VI). */
const titleCase = s => String(s || '').trim().replace(/\s+/g, ' ').split(' ')
  .map(w => /^[A-Z0-9]{2,4}$/.test(w) ? w : (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
  .join(' ');

/**
 * Public listing shape — never expose credentials, contact, bank/payout data,
 * the KYC images, or the raw verification payload. `idVerified` is a plain
 * boolean the UI uses to decide whether the "✓ ID Verified" badge is shown.
 */
const publicPro = ({ password, phone, email, idDocument, payout, kycMedia, idVerification, ...rest }) => ({
  ...rest,
  idVerified: rest.idVerified === true,
});

/** Compare phone numbers by their last 10 digits (0803… === +234803…). */
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);

const SORTERS = {
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
  resp:   (a, b) => (a.responseMins ?? 999) - (b.responseMins ?? 999),
  price:  (a, b) => (a.priceFrom ?? Number.MAX_SAFE_INTEGER) - (b.priceFrom ?? Number.MAX_SAFE_INTEGER),
  jobs:   (a, b) => (b.jobsDone ?? 0) - (a.jobsDone ?? 0),
};

/**
 * GET /api/pros?category=&state=&area=&sort=
 * Only verified pros are listed. If the requested state has no pros yet,
 * falls back to nationwide results with stateCovered:false so the UI can
 * say "no pros in X yet — showing top pros nationwide".
 * `area` (LGA/neighbourhood) is matched case-insensitively against each pro's
 * lga/area; `areaCovered` tells the "Book a Pro" wizard whether to offer the
 * matched pros or fall back to "Post a job". Nearby (same-state) pros are still
 * returned so the UI can suggest alternatives.
 * Ranking rule: sort key first, then subscription tier (Elite > Pro > Starter).
 */
export function listPros(req, res) {
  const { category, state, area, sort = 'rating' } = req.query;
  let pros = loadDB().professionals.filter(p => p.status === 'verified');

  if (category) pros = pros.filter(p => p.category === category);

  const inState = state ? pros.filter(p => p.state === state) : pros;
  const stateCovered = Boolean(state) && inState.length > 0;
  if (stateCovered) pros = inState;

  // Area match (only meaningful once we're within the requested state).
  const q = area ? String(area).trim().toLowerCase() : '';
  const matchesArea = p => q && [p.lga, p.area].some(v => v && String(v).toLowerCase().includes(q));
  const areaCovered = stateCovered && q ? pros.some(matchesArea) : false;

  const sorter = SORTERS[sort] || SORTERS.rating;
  const rank = (a, b) => sorter(a, b) || TIER_RANK[a.tier] - TIER_RANK[b.tier];
  // Surface area matches first, then the rest of the state, each ranked.
  if (areaCovered) {
    const inArea = pros.filter(matchesArea).sort(rank);
    const rest = pros.filter(p => !matchesArea(p)).sort(rank);
    pros = [...inArea, ...rest];
  } else {
    pros.sort(rank);
  }

  res.json({ pros: pros.map(publicPro), stateCovered, areaCovered });
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

  // Direct-contact leads go only to the addressed pro. Open job posts fan out
  // STRICTLY by profession: the lead's service must equal the pro's category
  // (a lead with no service reaches no inbox — every entry path sets one), and
  // the state must match when the lead has one.
  const leads = db.leads.filter(l =>
    (l.proId && String(l.proId) === String(pro.id)) ||
    (!l.proId && l.type !== 'direct_contact' &&
      l.service === pro.category &&
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

const BEARER = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const NUBAN_RE = /^\d{10}$/;

/**
 * GET /api/pros/:id/bookings   (pro, self only)
 * The pro's jobs, newest first — powers the "My jobs" dashboard section where
 * they start/complete/dispute. Includes customer contact so they can reach out.
 */
export function proBookings(req, res) {
  if (BEARER(req) !== 'demo-' + req.params.id) {
    return res.status(403).json({ ok: false, error: 'Not authorised.' });
  }
  const bookings = loadDB().bookings
    .filter(b => String(b.proId) === String(req.params.id))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, count: bookings.length, bookings });
}

/**
 * GET /api/pros/:id/payout   (pro, self only)
 * Returns whether the pro has a payout account on file, masked for display.
 * Never returns the recipient_code or the full account number.
 */
export function getPayoutAccount(req, res) {
  if (BEARER(req) !== 'demo-' + req.params.id) {
    return res.status(403).json({ ok: false, error: 'Not authorised.' });
  }
  const pro = loadDB().professionals.find(p => String(p.id) === String(req.params.id));
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });

  const p = pro.payout;
  if (!p?.recipientCode) return res.json({ ok: true, hasAccount: false });
  res.json({
    ok: true,
    hasAccount: true,
    payout: { bankName: p.bankName, accountName: p.accountName, accountLast4: p.accountLast4, verified: !!p.verified },
  });
}

/**
 * POST /api/pros/:id/payout   (pro, self only)
 * Body: { accountNumber, bankCode, bankName? }
 * Verifies the bank account with Paystack, creates a Transfer Recipient, and
 * stores the durable recipient_code (plus masked display fields). This is what
 * lets the release flow pay the pro. The full account number is NOT persisted.
 */
export async function setPayoutAccount(req, res) {
  // Auth: a pro may only set their OWN payout account.
  if (BEARER(req) !== 'demo-' + req.params.id) {
    return res.status(403).json({ ok: false, error: 'Not authorised to edit this profile.' });
  }

  const acct = String(req.body?.accountNumber || '').replace(/\s/g, '');
  const bank = String(req.body?.bankCode || '').trim();
  if (!NUBAN_RE.test(acct)) return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit account number.' });
  if (!/^\d{3,6}$/.test(bank)) return res.status(400).json({ ok: false, error: 'Select a valid bank.' });

  const pro = loadDB().professionals.find(p => String(p.id) === String(req.params.id));
  if (!pro) return res.status(404).json({ ok: false, error: 'Professional not found.' });

  // 1) Verify the account with the bank — prevents misdirected payouts.
  let resolved;
  try {
    resolved = await paystack.resolveAccount({ accountNumber: acct, bankCode: bank });
  } catch (err) {
    console.error('[payout] resolve', err.code || 'ERROR', '-', err.message);
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'Payments are not configured on the server yet.' });
    }
    // A resolve failure almost always means bad account details (client error).
    return res.status(422).json({ ok: false, error: 'We couldn’t verify that account number with the selected bank. Please check and try again.' });
  }
  const accountName = resolved?.account_name || null;

  // 2) Create the durable Transfer Recipient.
  let recipient;
  try {
    recipient = await paystack.createTransferRecipient({ name: pro.name, accountNumber: acct, bankCode: bank });
  } catch (err) {
    console.error('[payout] recipient', err.code || 'ERROR', '-', err.message);
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'Payments are not configured on the server yet.' });
    }
    return res.status(502).json({ ok: false, error: 'Payment gateway error while saving your bank account. Please try again.' });
  }

  // 3) Store the recipient_code + masked display fields. The full account
  //    number is deliberately NOT persisted — only the last 4 for display.
  const payout = {
    provider: 'paystack',
    recipientCode: recipient.recipient_code,
    bankCode: bank,
    bankName: recipient.details?.bank_name || (req.body?.bankName ? String(req.body.bankName).trim() : null),
    accountLast4: acct.slice(-4),
    accountName,
    verified: true,
    updatedAt: new Date().toISOString(),
  };
  await mutate(d => {
    const p = d.professionals.find(x => String(x.id) === String(req.params.id));
    if (p) p.payout = payout;
  });

  // Safe summary only — no recipient_code, no full account number.
  res.status(200).json({
    ok: true,
    message: 'Payout account verified and saved.',
    payout: { bankName: payout.bankName, accountName, accountLast4: payout.accountLast4, verified: true },
  });
}

/**
 * POST /api/pros/register
 * Body: { name, phone, trade, state, lga, plan, idType, idImage, selfieImage, ... }
 *
 * ID verification is real: the ID document photo and a live selfie are sent to
 * Dojah's photoid/verify endpoint, which checks the document and face-matches
 * the selfie against the ID photo.
 *
 *   verified     → status 'verified',       idVerified true  (badge granted)
 *   rejected     → status 'pending_review', idVerified false (human decides)
 *   inconclusive → status 'pending_review', idVerified false (human decides)
 *
 * A professional is NEVER auto-rejected by the machine, and the ID-verified
 * badge is NEVER granted without an actual pass (or an explicit admin approval).
 */
const ID_TYPES = ["NIN", "Driver's Licence", "International Passport"];

export async function registerPro(req, res) {
  const { name, phone, email, trade, state, lga, plan, idType, idImage, selfieImage,
          idFileName, idFileSizeKB, portfolio, password } = req.body || {};

  const missing = ['name', 'phone', 'trade', 'state'].filter(f => !req.body?.[f]?.toString().trim());
  if (missing.length) {
    return res.status(400).json({ ok: false, error: `Missing required fields: ${missing.join(', ')}` });
  }

  // ID verification is MANDATORY: a recognised ID type, the document photo,
  // AND a live selfie to match against it.
  const cleanIdType = idType?.toString().trim() || '';
  if (!ID_TYPES.includes(cleanIdType)) {
    return res.status(422).json({ ok: false, field: 'id', error: 'Select a valid ID type (NIN, driver’s licence or international passport).' });
  }
  if (!idImage?.toString().trim()) {
    return res.status(422).json({ ok: false, field: 'id', error: 'A photo of your government ID is required to register.' });
  }
  if (!selfieImage?.toString().trim()) {
    return res.status(422).json({ ok: false, field: 'selfie', error: 'A live selfie is required so we can match it to your ID.' });
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

  // Persist both images to PRIVATE storage (never /uploads) so a reviewer can
  // see exactly what was submitted if the automated check doesn't pass.
  const storedId = saveKycImage(idImage, 'id');
  const storedSelfie = saveKycImage(selfieImage, 'selfie');
  if (!storedId || !storedSelfie) {
    return res.status(422).json({ ok: false, field: 'id', error: 'Those images could not be read. Upload clear JPG or PNG photos under 10MB.' });
  }

  // Run the real check. Never throws — a failure becomes a review, not a 500.
  const nameParts = name.trim().split(/\s+/);
  const verification = await verifyPhotoIdWithSelfie({
    selfieImage,
    photoIdImage: idImage,
    firstName: nameParts[0],
    lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : undefined,
  });
  const passed = verification.outcome === 'verified';

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
    // The ID-verified badge is granted ONLY by a real pass (or admin approval).
    badges: passed ? ['v'] : [],
    tier: (plan || 'Starter').toLowerCase(),
    // scrypt hash — the raw value is never stored (null → shared fallback on login).
    password: password?.toString().trim() ? hashPassword(password.toString().trim()) : null,
    bio: `New on Servora — ID-verified ${trade.replace(/s$/, '').toLowerCase()} serving ${cleanLga ? cleanLga + ', ' : ''}${state}.`,
    review: null,
    skills: null,
    // Only a real pass makes a pro live/bookable; everything else waits for a human.
    status: passed ? 'verified' : 'pending_review',
    idVerified: passed,
    idDocument: { type: cleanIdType, fileName: idFileName ?? null, sizeKB: idFileSizeKB ?? null },
    // Private filenames only — served exclusively via the admin-authed endpoint.
    kycMedia: { idDocument: storedId.file, selfie: storedSelfie.file },
    idVerification: {
      provider: verification.provider,
      outcome: verification.outcome,          // verified | rejected | inconclusive
      confidence: verification.confidence,
      match: verification.match,
      reasons: verification.reasons,
      checks: verification.checks,
      checkedAt: verification.checkedAt,
      error: verification.error ?? null,
      // Audit trail: the provider's untouched response plus the exact context
      // the decision was made in. Kept so a disputed rejection can be
      // reconstructed later — including which threshold applied at the time.
      raw: verification.raw ?? null,
      endpoint: verification.endpoint ?? null,
      environment: verification.environment ?? null,
      thresholdUsed: verification.thresholdUsed ?? null,
      httpStatus: verification.httpStatus ?? null,
      decidedBy: null, decidedAt: null, decisionReason: null,
    },
    // Optional past-work photos (max 5) — written to /uploads, stored as URLs
    portfolio: persistPortfolio(portfolio),
    createdAt: new Date().toISOString(),
  };

  // Written through mutate(): the Dojah call above is an async gap, so a plain
  // load→save could clobber a concurrent write.
  const added = await mutate((d) => {
    // Re-check uniqueness inside the lock in case a duplicate landed meanwhile.
    if (d.professionals.some(p => normPhone(p.phone) === normPhone(phone))) return false;
    d.professionals.push(pro);
    return true;
  });
  if (!added) {
    return res.status(409).json({ ok: false, field: 'phone', error: 'This phone number is already registered. Try signing in instead.' });
  }

  res.status(201).json({
    ok: true,
    status: pro.status,
    idVerified: pro.idVerified,
    verification: { outcome: verification.outcome, confidence: verification.confidence, reasons: verification.reasons },
    pro: publicPro(pro),
    message: passed
      ? 'ID verified — your profile is live in listings now.'
      : 'Application received. Your ID needs a quick manual check by our team, usually within 24 hours. Your profile stays hidden until then.',
  });
}
