/**
 * Professionals + their KYC checks.
 * Rows are mapped back to the exact camelCase shape the API has always used,
 * so controllers and the frontend see the same objects as before.
 */
import { db } from '../db/pool.js';
import { iso, isUuid, updateSql } from './util.js';

/* ------------------------------------------------------------ mapping */

export function toPro(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    category: r.category,
    state: r.state,
    lga: r.lga,
    area: r.area,
    city: r.city,
    rating: r.rating,
    jobsDone: r.jobs_done,
    priceFrom: r.price_from,
    priceLabel: r.price_label,
    responseMins: r.response_mins,
    avatarColor: r.avatar_color,
    badges: r.badges,
    tier: r.tier,
    password: r.password_hash,          // hash only; publicPro() strips it
    bio: r.bio,
    review: r.review,
    skills: r.skills,
    status: r.status,
    idVerified: r.id_verified,
    otpVerified: r.otp_verified,
    otpVerifiedAt: iso(r.otp_verified_at),
    contactVerification: r.contact_verified_channel
      ? { channel: r.contact_verified_channel, verifiedAt: iso(r.otp_verified_at) } : null,
    idDocument: r.id_document_type
      ? { type: r.id_document_type, fileName: r.id_document_file_name, sizeKB: r.id_document_size_kb } : null,
    kycMedia: (r.kyc_id_image_key || r.kyc_selfie_key)
      ? { idDocument: r.kyc_id_image_key, selfie: r.kyc_selfie_key } : null,
    portfolio: r.portfolio,
    availableNow: r.available_now,
    availabilityUpdatedAt: iso(r.availability_updated_at),
    location: r.lat != null ? { lat: r.lat, lng: r.lng, source: r.location_source } : null,
    payout: (r.payout_provider || r.payout_recipient_code) ? {
      provider: r.payout_provider,
      recipientCode: r.payout_recipient_code,
      bankCode: r.payout_bank_code,
      bankName: r.payout_bank_name,
      accountLast4: r.payout_account_last4,
      accountName: r.payout_account_name,
      verified: r.payout_verified,
      updatedAt: iso(r.payout_updated_at),
    } : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toKycCheck(r) {
  if (!r) return null;
  return {
    id: r.id,
    provider: r.provider,
    outcome: r.outcome,
    autoOutcome: r.auto_outcome,
    confidence: r.confidence,
    match: r.match,
    reasons: r.reasons,
    checks: r.checks,
    checkedAt: iso(r.checked_at),
    error: r.error,
    raw: r.raw,
    endpoint: r.endpoint,
    environment: r.environment,
    thresholdUsed: r.threshold_used,
    httpStatus: r.http_status,
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
    decisionReason: r.decision_reason,
  };
}

/* ------------------------------------------------------------ fields */

const SIMPLE = {
  name: 'name', phone: 'phone', email: 'email', category: 'category', state: 'state', lga: 'lga',
  area: 'area', city: 'city', rating: 'rating', jobsDone: 'jobs_done', priceFrom: 'price_from',
  priceLabel: 'price_label', responseMins: 'response_mins', avatarColor: 'avatar_color',
  badges: 'badges', tier: 'tier', password: 'password_hash', bio: 'bio', skills: 'skills',
  status: 'status', idVerified: 'id_verified', otpVerified: 'otp_verified',
  otpVerifiedAt: 'otp_verified_at', portfolio: 'portfolio', availableNow: 'available_now',
  availabilityUpdatedAt: 'availability_updated_at',
};

/** camelCase patch (incl. nested location/payout/contactVerification) → [column, value] pairs. */
function proPairs(patch) {
  const pairs = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (SIMPLE[k]) pairs.push([SIMPLE[k], v]);
    else if (k === 'review') pairs.push(['review', v == null ? null : JSON.stringify(v)]);
    else if (k === 'location') {
      pairs.push(['lat', v?.lat ?? null], ['lng', v?.lng ?? null], ['location_source', v?.source ?? null]);
    } else if (k === 'payout') {
      pairs.push(
        ['payout_provider', v?.provider ?? null],
        ['payout_recipient_code', v?.recipientCode ?? null],
        ['payout_bank_code', v?.bankCode ?? null],
        ['payout_bank_name', v?.bankName ?? null],
        ['payout_account_last4', v?.accountLast4 ?? null],
        ['payout_account_name', v?.accountName ?? null],
        ['payout_verified', v?.verified === true],
        ['payout_updated_at', v?.updatedAt ?? null],
      );
    } else if (k === 'contactVerification') pairs.push(['contact_verified_channel', v?.channel ?? null]);
    else throw new Error(`professionals: field "${k}" cannot be updated`);
  }
  return pairs;
}

/* ------------------------------------------------------------ reads */

export async function getPro(id, client) {
  if (!isUuid(id)) return null;
  const { rows } = await db(client).query('SELECT * FROM professionals WHERE id = $1', [id]);
  return toPro(rows[0]);
}

/** Row-locked read for read-modify-write inside a transaction. */
export async function getProForUpdate(client, id) {
  if (!isUuid(id)) return null;
  const { rows } = await client.query('SELECT * FROM professionals WHERE id = $1 FOR UPDATE', [id]);
  return toPro(rows[0]);
}

/** Verified pros, optionally for one trade (listing applies the OTP gate + ranking). */
export async function listVerifiedPros({ category = null } = {}) {
  const { rows } = await db().query(
    `SELECT * FROM professionals
      WHERE status = 'verified' AND ($1::text IS NULL OR category = $1)
      ORDER BY created_at`, [category || null]);
  return rows.map(toPro);
}

export async function listFeaturedPros() {
  const { rows } = await db().query(
    "SELECT * FROM professionals WHERE status = 'verified' AND tier <> 'starter' ORDER BY created_at");
  return rows.map(toPro);
}

/** Login lookup: a verified pro by phone (last 10 digits) or email. */
export async function findVerifiedForLogin({ phoneKey, email }) {
  const { rows } = await db().query(
    `SELECT * FROM professionals
      WHERE status = 'verified'
        AND ((length($1::text) = 10 AND phone_key = $1::text) OR (email IS NOT NULL AND lower(email) = $2::text))
      ORDER BY created_at LIMIT 1`, [phoneKey || '', email || '']);
  return toPro(rows[0]);
}

/** Is this phone (last 10 digits) or email already registered? */
export async function contactTaken({ phoneKey, email }) {
  const { rows } = await db().query(
    `SELECT EXISTS (SELECT 1 FROM professionals WHERE phone_key = $1) AS phone,
            EXISTS (SELECT 1 FROM professionals WHERE $2::text <> '' AND lower(email) = $2::text) AS email`,
    [phoneKey || '', email || '']);
  return rows[0];
}

/* ------------------------------------------------------------ writes */

/** Insert a new professional (inside the registration transaction). */
export async function insertPro(client, p) {
  await client.query(
    `INSERT INTO professionals (
       id, name, phone, email, category, state, lga, area, city, rating, jobs_done, price_from,
       price_label, response_mins, avatar_color, badges, tier, password_hash, bio, review, skills,
       status, id_verified, otp_verified, otp_verified_at, id_document_type, id_document_file_name,
       id_document_size_kb, kyc_id_image_key, kyc_selfie_key, portfolio, available_now,
       availability_updated_at, lat, lng, location_source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)`,
    [p.id, p.name, p.phone, p.email, p.category, p.state, p.lga, p.area, p.city, p.rating,
     p.jobsDone ?? 0, p.priceFrom, p.priceLabel, p.responseMins, p.avatarColor, p.badges || [],
     p.tier, p.password, p.bio, p.review == null ? null : JSON.stringify(p.review), p.skills,
     p.status, p.idVerified === true, p.otpVerified === true, p.otpVerifiedAt,
     p.idDocument?.type ?? null, p.idDocument?.fileName ?? null, p.idDocument?.sizeKB ?? null,
     p.kycMedia?.idDocument ?? null, p.kycMedia?.selfie ?? null, p.portfolio || [],
     p.availableNow === true, p.availabilityUpdatedAt, p.location?.lat ?? null,
     p.location?.lng ?? null, p.location?.source ?? null, p.createdAt]);
}

/** Apply a camelCase patch; returns the updated pro, or null if not found. */
export async function updatePro(id, patch, client) {
  if (!isUuid(id)) return null;
  const pairs = proPairs(patch);
  if (!pairs.length) return getPro(id, client);
  const { text, params } = updateSql('professionals', pairs, 'id = $1', [id]);
  const { rows } = await db(client).query(text, params);
  return toPro(rows[0]);
}

/** Fill in coordinates only if the pro still has none (background geocode). */
export async function setLocationIfMissing(id, { lat, lng, source }) {
  if (!isUuid(id)) return;
  await db().query(
    'UPDATE professionals SET lat = $2, lng = $3, location_source = $4 WHERE id = $1 AND lat IS NULL',
    [id, lat, lng, source ?? null]);
}

/* ------------------------------------------------------------ KYC checks */

export async function insertKycCheck(client, proId, v) {
  await client.query(
    `INSERT INTO kyc_checks (pro_id, provider, outcome, auto_outcome, confidence, match, reasons,
       checks, error, raw, endpoint, environment, threshold_used, http_status, checked_at,
       decided_by, decided_at, decision_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [proId, v.provider, v.outcome, v.autoOutcome ?? null,
     Number.isFinite(v.confidence) ? v.confidence : null, v.match ?? null, v.reasons || [],
     JSON.stringify(v.checks || {}), v.error ?? null, v.raw == null ? null : JSON.stringify(v.raw),
     v.endpoint ?? null, v.environment ?? null, v.thresholdUsed ?? null, v.httpStatus ?? null,
     v.checkedAt || new Date().toISOString(), v.decidedBy ?? null, v.decidedAt ?? null,
     v.decisionReason ?? null]);
}

const LATEST_CHECK = `LEFT JOIN LATERAL (
    SELECT k.* FROM kyc_checks k WHERE k.pro_id = p.id ORDER BY k.created_at DESC, k.id DESC LIMIT 1
  ) kc ON true`;

/** Split a joined row into { pro, check }. */
function withCheck(r) {
  const pro = toPro(r);
  if (r.kc_id != null) {
    pro.idVerification = toKycCheck({
      id: r.kc_id, provider: r.kc_provider, outcome: r.kc_outcome, auto_outcome: r.kc_auto_outcome,
      confidence: r.kc_confidence, match: r.kc_match, reasons: r.kc_reasons, checks: r.kc_checks,
      checked_at: r.kc_checked_at, error: r.kc_error, raw: r.kc_raw, endpoint: r.kc_endpoint,
      environment: r.kc_environment, threshold_used: r.kc_threshold_used, http_status: r.kc_http_status,
      decided_by: r.kc_decided_by, decided_at: r.kc_decided_at, decision_reason: r.kc_decision_reason,
    });
  } else pro.idVerification = null;
  return pro;
}
const KC_COLS = `kc.id AS kc_id, kc.provider AS kc_provider, kc.outcome AS kc_outcome,
  kc.auto_outcome AS kc_auto_outcome, kc.confidence AS kc_confidence, kc.match AS kc_match,
  kc.reasons AS kc_reasons, kc.checks AS kc_checks, kc.checked_at AS kc_checked_at,
  kc.error AS kc_error, kc.raw AS kc_raw, kc.endpoint AS kc_endpoint,
  kc.environment AS kc_environment, kc.threshold_used AS kc_threshold_used,
  kc.http_status AS kc_http_status, kc.decided_by AS kc_decided_by,
  kc.decided_at AS kc_decided_at, kc.decision_reason AS kc_decision_reason`;

/** KYC review queue. status 'all' = everyone who has been through a check. */
export async function listProsForKyc(status) {
  const { rows } = await db().query(
    `SELECT p.*, ${KC_COLS} FROM professionals p ${LATEST_CHECK}
      WHERE ($1::text = 'all' AND kc.id IS NOT NULL) OR ($1::text <> 'all' AND p.status = $1::text)
      ORDER BY p.created_at DESC`, [status]);
  return rows.map(withCheck);
}

/** One pro with their latest KYC check as `idVerification`. */
export async function getProWithKyc(id, client) {
  if (!isUuid(id)) return null;
  const { rows } = await db(client).query(
    `SELECT p.*, ${KC_COLS} FROM professionals p ${LATEST_CHECK} WHERE p.id = $1`, [id]);
  return rows[0] ? withCheck(rows[0]) : null;
}

/** Record a reviewer's decision on the pro's latest check (inside a transaction). */
export async function recordKycDecision(client, checkId, { outcome, autoOutcome, decidedBy, decisionReason }) {
  await client.query(
    `UPDATE kyc_checks SET outcome = $2, auto_outcome = $3, decided_by = $4, decided_at = now(),
            decision_reason = $5 WHERE id = $1`,
    [checkId, outcome, autoOutcome, decidedBy, decisionReason]);
}
