/**
 * Auth controller — DEMO-GRADE professional sign-in.
 *
 * A pro signs in with their registered WhatsApp number (any format:
 * 0803…, +234 803…, spaces/dashes ignored) or email, plus a password.
 * Pros who never set a password use the shared DEMO_PASSWORD.
 *
 * SECURITY (acknowledged, for later):
 *  - passwords are stored in plain text  → bcrypt/argon2 hashes
 *  - the token is a fake bearer string   → signed JWT / session cookie
 *  - no rate limiting                    → add on real deployment
 *  - preferred long-term flow: WhatsApp OTP instead of passwords
 */
import { loadDB } from '../store/store.js';

export const DEMO_PASSWORD = 'servora123';

/** Compare phone numbers by their last 10 digits (0803… === +234803…). */
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);

export function login(req, res) {
  const { identifier, password } = req.body || {};
  if (!identifier?.toString().trim() || !password) {
    return res.status(400).json({ ok: false, error: 'Enter your WhatsApp number (or email) and password.' });
  }

  const idText = identifier.toString().trim().toLowerCase();
  const idPhone = normPhone(identifier);

  const pro = loadDB().professionals.find(p =>
    p.status === 'verified' && (
      (idPhone.length === 10 && normPhone(p.phone) === idPhone) ||
      (p.email && String(p.email).toLowerCase() === idText)
    )
  );

  if (!pro) {
    return res.status(401).json({ ok: false, error: 'No verified professional found with that number or email.' });
  }

  const expected = pro.password || DEMO_PASSWORD;
  if (password !== expected) {
    return res.status(401).json({ ok: false, error: 'Incorrect password. (Accounts without a password use the demo password.)' });
  }

  // Public profile only — never echo password/phone/documents back.
  // Includes the fields the dashboard shows and lets the pro edit.
  res.json({
    ok: true,
    token: 'demo-' + pro.id,
    pro: {
      id: pro.id, name: pro.name, category: pro.category, state: pro.state,
      avatarColor: pro.avatarColor, tier: pro.tier, rating: pro.rating,
      jobsDone: pro.jobsDone, bio: pro.bio, responseMins: pro.responseMins,
      priceFrom: pro.priceFrom, priceLabel: pro.priceLabel, portfolio: pro.portfolio || [],
    },
  });
}
