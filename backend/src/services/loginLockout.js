/**
 * Per-account sign-in lockout, on top of the per-IP limit on the login route:
 * after 10 failures for one phone/email in 15 minutes, that account is locked
 * for the rest of the window — so spreading guesses across many IPs doesn't
 * help. In memory (one instance); a restart clears it.
 */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map();   // key -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
}, 60_000).unref();

/** Lockout key for a login identifier: last 10 phone digits, else the lower-cased email. */
export function loginKey(identifier) {
  const phone = String(identifier || '').replace(/\D/g, '').slice(-10);
  return phone.length === 10 ? 'p:' + phone : 'e:' + String(identifier || '').trim().toLowerCase();
}

/** Seconds left on a lockout, or 0. */
export function lockedOut(key) {
  const f = failures.get(key);
  return f && f.resetAt > Date.now() && f.count >= MAX_FAILS ? Math.ceil((f.resetAt - Date.now()) / 1000) : 0;
}

export function recordFailure(key) {
  const f = failures.get(key);
  if (!f || f.resetAt <= Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
  else f.count += 1;
}

export function clearFailures(...keys) {
  for (const k of keys) failures.delete(k);
}
