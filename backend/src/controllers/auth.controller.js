/**
 * Auth controller — professional sign-in.
 *
 * A pro signs in with their registered WhatsApp number (any format:
 * 0803…, +234 803…, spaces/dashes ignored) or email, plus a password.
 * Passwords are stored as scrypt hashes; legacy plain-text values are
 * verified transparently and upgraded to hashes on successful login.
 * Pros who never set a password use the shared fallback password
 * (seed/demo accounts only — not surfaced anywhere in the UI).
 *
 * FUTURE: signed JWT / session cookie instead of the bearer string;
 * preferred long-term flow is WhatsApp OTP instead of passwords.
 */
import { loadDB, mutate } from '../store/store.js';
import { verifyPassword, needsRehash, hashPassword } from '../services/passwords.js';

export const DEMO_PASSWORD = 'servora123';

/** Compare phone numbers by their last 10 digits (0803… === +234803…). */
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);

export async function login(req, res) {
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

  if (!verifyPassword(password, pro.password || DEMO_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }

  // Transparent upgrade: legacy plain-text password → scrypt hash.
  if (needsRehash(pro.password)) {
    const hashed = hashPassword(password);
    await mutate(d => {
      const p = d.professionals.find(x => String(x.id) === String(pro.id));
      if (p && p.password && needsRehash(p.password)) p.password = hashed;
    });
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
