/**
 * Password hashing — scrypt from node:crypto, no dependencies.
 *
 * Stored format:  scrypt:N:r:p:<salt b64>:<hash b64>
 *
 * Async on purpose: scrypt runs on libuv's thread pool, so hashing a password
 * never blocks the event loop. (On Render's 0.1-CPU instance a synchronous
 * hash stalled every other request while it ran.)
 *
 * Only scrypt hashes are accepted — a stored value in any other form never
 * verifies.
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 32;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

const isHash = (stored) => typeof stored === 'string' && /^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(stored);

export async function verifyPassword(password, stored) {
  if (!isHash(stored)) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split(':');
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a valid hash uses older cost parameters and should be re-hashed on sign-in. */
export function needsRehash(stored) {
  if (!isHash(stored)) return false;
  const [, n, r, p] = stored.split(':');
  return Number(n) !== N || Number(r) !== R || Number(p) !== P;
}

/** Password rule for new accounts. Returns an error message, or null when acceptable. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || !password) return 'Create a password to sign in with.';
  if (password.length < 8) return 'Use at least 8 characters for your password.';
  if (password.length > 200) return 'That password is too long (200 characters max).';
  return null;
}
