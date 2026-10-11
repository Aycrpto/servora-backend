/** Small helpers shared by the Postgres store modules. */

/** Postgres timestamps → the ISO strings the API has always returned. */
export const iso = (d) => (d == null ? null : new Date(d).toISOString());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids from URLs are checked before they reach a uuid column (bad input → 404, not 500). */
export const isUuid = (v) => UUID_RE.test(String(v ?? ''));

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Build a parameterised UPDATE. Column names come ONLY from the caller's
 * hard-coded field maps — never from request input — and are re-checked as
 * plain identifiers; every value is a $n parameter.
 *   updateSql('bookings', [['status', 'funded']], 'id = $1', [id])
 */
export function updateSql(table, pairs, where, whereParams, returning = '*') {
  const params = [...whereParams];
  const sets = pairs.map(([col, val]) => {
    if (!IDENT_RE.test(col)) throw new Error(`bad column name: ${col}`);
    params.push(val);
    return `${col} = $${params.length}`;
  });
  return { text: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where} RETURNING ${returning}`, params };
}

/** Map a camelCase patch to [column, value] pairs via a fixed field map. */
export function pairsFrom(map, patch, table) {
  const pairs = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    const col = map[k];
    if (!col) throw new Error(`${table}: field "${k}" cannot be updated`);
    pairs.push([col, v]);
  }
  return pairs;
}

/** Postgres unique-violation on a named constraint/index. */
export const isUniqueViolation = (err, name) =>
  err?.code === '23505' && (!name || err.constraint === name);
