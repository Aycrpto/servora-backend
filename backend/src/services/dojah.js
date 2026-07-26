/**
 * Dojah KYC — ID document + selfie (face match) verification.
 *
 * Endpoint (per Dojah docs):
 *   POST {baseUrl}/api/v1/kyc/photoid/verify
 *   headers: AppId: <app id>, Authorization: <private key>   ← raw key, NOT "Bearer"
 *   body:    { selfie_image, photoid_image, first_name?, last_name? }
 *            images are RAW base64 — the "data:image/jpeg;base64," prefix must be stripped.
 *   response: { entity: { selfie: { confidence_value, match, selfie_image_blurry,
 *              photoId_image_blurry, selfie_glare, photoId_glare, age_range,
 *              sunglasses, card_type, first_name:{...}, last_name:{...} } } }
 *
 * Base URLs: sandbox https://sandbox.dojah.io · live https://api.dojah.io
 *
 * This module NEVER throws for a failed verification — a rejected or
 * inconclusive check is a normal outcome that routes the pro to manual review.
 * It only reports transport/config problems via outcome 'inconclusive'.
 */
import { DOJAH_APP_ID, DOJAH_PRIVATE_KEY, DOJAH_BASE_URL, DOJAH_CONFIGURED, DOJAH_MATCH_THRESHOLD, DOJAH_ENV } from '../config.js';

const TIMEOUT_MS = 30000;

/** Strip a data-URL prefix and whitespace — Dojah wants raw base64 only. */
export function toRawBase64(image) {
  if (typeof image !== 'string') return '';
  return image.replace(/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
}

/**
 * Verify that a government ID is genuine and its photo matches a live selfie.
 *
 * Returns a normalised result — never throws:
 *   { outcome: 'verified' | 'rejected' | 'inconclusive',
 *     confidence, match, reasons[], checks{}, provider, raw, error? }
 *
 * outcome 'verified'     → Dojah says match AND confidence >= threshold
 * outcome 'rejected'     → Dojah answered, but the faces don't match
 * outcome 'inconclusive' → not configured / network / bad response / unusable images
 * Only 'verified' may ever grant the ID-verified badge. Everything else is
 * routed to a human — we never auto-reject a professional.
 */
export async function verifyPhotoIdWithSelfie({ selfieImage, photoIdImage, firstName, lastName } = {}) {
  const endpoint = `${DOJAH_BASE_URL}/api/v1/kyc/photoid/verify`;
  // Audit context: recorded with every result so a disputed decision can be
  // reconstructed exactly — including WHICH threshold was in force at the time.
  const base = {
    provider: 'dojah', checkedAt: new Date().toISOString(),
    confidence: null, match: null, checks: {}, raw: null,
    endpoint, environment: DOJAH_ENV, thresholdUsed: DOJAH_MATCH_THRESHOLD, httpStatus: null,
  };

  if (!DOJAH_CONFIGURED) {
    return { ...base, outcome: 'inconclusive', reasons: ['Dojah is not configured on the server.'], error: 'DOJAH_NOT_CONFIGURED' };
  }
  const selfie_image = toRawBase64(selfieImage);
  const photoid_image = toRawBase64(photoIdImage);
  if (!selfie_image || !photoid_image) {
    return { ...base, outcome: 'inconclusive', reasons: ['A selfie and an ID document image are both required.'], error: 'MISSING_IMAGE' };
  }

  const body = { selfie_image, photoid_image };
  if (firstName) body.first_name = String(firstName).trim();
  if (lastName) body.last_name = String(lastName).trim();

  let res, payload;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          AppId: DOJAH_APP_ID,
          Authorization: DOJAH_PRIVATE_KEY,   // raw key — Dojah does not use a Bearer prefix
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    payload = await res.json().catch(() => null);
  } catch (err) {
    // Network failure / timeout — a human decides, we never reject on our own.
    return { ...base, outcome: 'inconclusive', reasons: ['Could not reach the verification service.'], error: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }

  base.httpStatus = res.status;

  if (!res.ok) {
    const msg = payload?.error || payload?.message || `HTTP ${res.status}`;
    return { ...base, outcome: 'inconclusive', raw: payload, reasons: [`Verification service error: ${msg}`], error: 'PROVIDER_ERROR' };
  }

  const selfie = payload?.entity?.selfie;
  if (!selfie || typeof selfie !== 'object') {
    return { ...base, outcome: 'inconclusive', raw: payload, reasons: ['Verification service returned an unreadable result.'], error: 'BAD_RESPONSE' };
  }

  const confidence = Number(selfie.confidence_value);
  const match = selfie.match === true;
  const checks = {
    selfieBlurry: selfie.selfie_image_blurry === true,
    photoIdBlurry: selfie.photoId_image_blurry === true,
    selfieGlare: selfie.selfie_glare === true,
    photoIdGlare: selfie.photoId_glare === true,
    sunglasses: selfie.sunglasses === true,
    cardType: selfie.card_type ?? null,
    ageRange: selfie.age_range ?? null,
    firstNameMatch: selfie.first_name?.match ?? null,
    lastNameMatch: selfie.last_name?.match ?? null,
  };

  const reasons = [];
  if (checks.selfieBlurry) reasons.push('The selfie image is blurry.');
  if (checks.photoIdBlurry) reasons.push('The ID document image is blurry.');
  if (checks.sunglasses) reasons.push('Sunglasses were detected in the selfie.');
  if (checks.selfieGlare) reasons.push('Glare was detected on the selfie.');
  if (checks.photoIdGlare) reasons.push('Glare was detected on the ID document.');

  // A usable score is required before we trust either verdict.
  if (!Number.isFinite(confidence)) {
    return { ...base, outcome: 'inconclusive', raw: payload, checks, confidence: null, match,
      reasons: [...reasons, 'No confidence score was returned.'], error: 'NO_CONFIDENCE' };
  }

  // Auto-verify only on an unambiguous pass: Dojah's own match flag AND our
  // threshold. Anything blurry/obscured is sent to a human even if it scored.
  const unusable = checks.selfieBlurry || checks.photoIdBlurry || checks.sunglasses;
  if (match && confidence >= DOJAH_MATCH_THRESHOLD && !unusable) {
    return { ...base, outcome: 'verified', confidence, match: true, checks, raw: payload, reasons: [] };
  }
  if (!match || confidence < DOJAH_MATCH_THRESHOLD) {
    return { ...base, outcome: 'rejected', confidence, match, checks, raw: payload,
      reasons: [...reasons, `Selfie did not match the ID photo (confidence ${confidence}%, need ${DOJAH_MATCH_THRESHOLD}%).`] };
  }
  // Matched and scored, but the images were poor quality — human review.
  return { ...base, outcome: 'inconclusive', confidence, match, checks, raw: payload,
    reasons: [...reasons, 'Image quality was too poor to auto-approve.'] };
}
