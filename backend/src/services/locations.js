/**
 * The canonical lists a pro's trade and location are checked against.
 *
 *   trades — backend/src/data/services.json (the 8 launch trades)
 *   states — the 36 states + FCT, spelled exactly as the site shows them
 *            ("FCT Abuja", "Akwa Ibom", …)
 *   LGAs   — backend/src/data/nigeria-lgas.json, all 774, keyed by state
 *
 * Matching ignores case, spacing and punctuation ("eti osa" = "Eti-Osa",
 * "obio akpor" = "Obio/Akpor"), plus a few well-known alternative names
 * (Shagamu → Sagamu, AMAC → Abuja Municipal). Every lookup returns the
 * canonical spelling, which is what gets stored — never the raw input.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f) => JSON.parse(readFileSync(path.join(dataDir, f), 'utf8'));

const LGAS_BY_STATE = read('nigeria-lgas.json');
export const TRADES = read('services.json').map((s) => s.name);
export const STATES = Object.keys(LGAS_BY_STATE);

/** Case, spacing and punctuation don't matter; letters (any script) do. */
const key = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Other names in use for the same LGA → its canonical name, per state. */
const LGA_ALIASES = {
  'Abia': { 'Osisioma': 'Osisioma Ngwa', 'Obingwa': 'Obi Ngwa' },
  'Adamawa': { 'Fufure': 'Fufore' },
  'Bauchi': { 'Damban': 'Dambam' },
  'Benue': { 'Oturkpo': 'Otukpo' },
  'Cross River': { 'Yakuur': 'Yakurr' },
  'Ebonyi': { 'Afikpo': 'Afikpo North', 'Edda': 'Afikpo South' },
  'FCT Abuja': { 'Abuja Municipal Area Council': 'Abuja Municipal', 'AMAC': 'Abuja Municipal', 'Municipal Area Council': 'Abuja Municipal' },
  'Jigawa': { 'Birniwa': 'Biriniwa' },
  'Kano': { 'Ghari': 'Kunchi' },
  'Kwara': { 'Patigi': 'Pategi' },
  'Lagos': { 'Ifako-Ijaye': 'Ifako-Ijaiye', 'Somolu': 'Shomolu' },
  'Nasarawa': { 'Nasarawa Egon': 'Nasarawa Eggon' },
  'Ogun': { 'Shagamu': 'Sagamu', 'Egbado North': 'Yewa North', 'Egbado South': 'Yewa South' },
  'Oyo': { 'Orire': 'Ori Ire', 'Ogbomoso North': 'Ogbomosho North', 'Ogbomoso South': 'Ogbomosho South' },
  'Rivers': { 'Okirika': 'Okrika' },
  'Sokoto': { 'Wamako': 'Wamakko', 'Isah': 'Isa' },
  'Yobe': { 'Bursali': 'Bursari' },
};

const tradeIndex = new Map(TRADES.map((t) => [key(t), t]));
const stateIndex = new Map(STATES.map((s) => [key(s), s]));
// "Abuja" and "FCT" are how most people write the capital territory.
stateIndex.set(key('Abuja'), 'FCT Abuja');
stateIndex.set(key('FCT'), 'FCT Abuja');
stateIndex.set(key('Federal Capital Territory'), 'FCT Abuja');
const lgaIndex = new Map(STATES.map((s) => {
  const m = new Map(LGAS_BY_STATE[s].map((l) => [key(l), l]));
  for (const [alias, canonical] of Object.entries(LGA_ALIASES[s] || {})) m.set(key(alias), canonical);
  return [s, m];
}));

/** Canonical trade name, or null if it isn't one of ours. */
export const canonicalTrade = (v) => tradeIndex.get(key(v)) ?? null;
/** Canonical state name, or null if it isn't a Nigerian state / the FCT. */
export const canonicalState = (v) => stateIndex.get(key(v)) ?? null;
/** Canonical LGA name within a (canonical) state, or null. */
export const canonicalLga = (state, v) => lgaIndex.get(state)?.get(key(v)) ?? null;
/** The LGAs of a (canonical) state, in display order. */
export const lgasOf = (state) => LGAS_BY_STATE[state] ?? [];
/** States with their LGAs, for the sign-up form's pickers. */
export const locationList = () => STATES.map((name) => ({ name, lgas: LGAS_BY_STATE[name] }));

/* ---------------------------------------------------------------------------
 * Customer areas → LGAs. Pros are listed by LGA ("Eti-Osa"); customers type
 * neighbourhoods ("Lekki", "VI, near Ajah"). data/neighbourhoods.json holds
 * the names we're confident about; LGA names and their aliases count too.
 *
 * Matching is by whole words, longest name first, within the chosen state:
 * "Ojota" is not Ojo, "Ibadan" is not Iba, "Lekki Free Trade Zone" beats
 * "Lekki", and "Mile 2" in Rivers is not "Mile 2" in Lagos. Spacing and
 * punctuation don't matter ("V.I." = "VI", "lekki phase1" = "Lekki Phase 1").
 * ------------------------------------------------------------------------- */
const areaWords = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const NEIGHBOURHOODS = read('neighbourhoods.json');
const AREA_INDEX = new Map(STATES.map((state) => {
  const phrases = new Map();   // collapsed words → { label, lgas: Set }
  const add = (name, lgas) => {
    const k = areaWords(name).join('');
    if (!k) return;
    const e = phrases.get(k) || { label: name, lgas: new Set() };
    lgas.forEach((l) => e.lgas.add(l));
    phrases.set(k, e);
  };
  for (const l of LGAS_BY_STATE[state]) add(l, [l]);
  for (const [alias, canonical] of Object.entries(LGA_ALIASES[state] || {})) add(alias, [canonical]);
  for (const [lga, names] of Object.entries(NEIGHBOURHOODS[state] || {})) {
    if (lga === '_unmapped') { names.forEach((n) => add(n, [])); continue; }
    if (canonicalLga(state, lga) !== lga) throw new Error(`neighbourhoods.json: "${lga}" is not an LGA of ${state}`);
    names.forEach((n) => add(n, [lga]));
  }
  const maxWords = Math.max(...[...phrases.values()].map((e) => areaWords(e.label).length));
  return [state, { phrases, maxWords }];
}));

/**
 * Resolve what a customer typed as their area, within a state.
 * Returns { recognised, lgas, matched }:
 *   recognised — at least one known name (or LGA) appeared in the text
 *   lgas       — the canonical LGAs those names sit in (may be empty)
 *   matched    — the names as we spell them, e.g. ["Lekki"]
 * Unrecognised text resolves to nothing; the caller decides the fallback.
 */
export function resolveArea(state, text) {
  const idx = AREA_INDEX.get(canonicalState(state));
  const out = { recognised: false, lgas: [], matched: [] };
  if (!idx) return out;
  const ws = areaWords(text);
  const lgas = new Set(), matched = [];
  for (let i = 0; i < ws.length;) {
    let hit = null, len = 0;
    for (let n = Math.min(idx.maxWords, ws.length - i); n >= 1 && !hit; n--) {
      const e = idx.phrases.get(ws.slice(i, i + n).join(''));
      if (e) { hit = e; len = n; }
    }
    if (!hit) { i++; continue; }
    out.recognised = true;
    if (hit.lgas.size) { hit.lgas.forEach((l) => lgas.add(l)); if (!matched.includes(hit.label)) matched.push(hit.label); }
    i += len;
  }
  out.lgas = [...lgas];
  out.matched = matched;
  return out;
}
