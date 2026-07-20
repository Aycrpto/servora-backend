/**
 * Password hashing — zero-dependency scrypt (node:crypto).
 *
 * Stored format:  scrypt:N:r:p:<salt b64>:<hash b64>
 * verifyPassword() also accepts legacy PLAIN-TEXT stored values (pre-hashing
 * accounts) so existing pros keep working; the login flow upgrades those to
 * hashes transparently on their next successful sign-in (see needsRehash).
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

const isHash = (stored) => typeof stored === 'string' && stored.startsWith('scrypt:');

export function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!isHash(stored)) {
    // Legacy plain-text value — constant-time compare on equal-length buffers.
    const a = Buffer.from(String(password)), b = Buffer.from(String(stored));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const [, n, r, p, saltB64, hashB64] = stored.split(':');
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when the stored value should be upgraded to a scrypt hash. */
export const needsRehash = (stored) => Boolean(stored) && !isHash(stored);
