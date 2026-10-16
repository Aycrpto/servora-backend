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
