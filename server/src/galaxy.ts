// The galactic war: one persistent, server-wide campaign shared by every squad.
// Completed missions liberate the active planet; when it hits 100% the front
// advances. Stored as a single JSON file with the same debounced/atomic write
// strategy as profiles. HD_DATA_DIR overrides the location for tests.

import fs from 'node:fs';
import path from 'node:path';
import { GALAXY, PLANETS } from '../../shared/constants.js';
import type { GalaxyState } from '../../shared/protocol.js';

const dataDir = path.resolve(process.env.HD_DATA_DIR ?? path.join(process.cwd(), 'server', 'data'));
const file = path.join(dataDir, 'galaxy.json');

function fresh(): GalaxyState {
  return {
    planets: PLANETS.map((p) => ({ ...p, liberation: 0, liberated: false })),
    activePlanet: PLANETS[0].id,
    missionsWon: 0,
    totalKills: 0,
  };
}

let state: GalaxyState = load();

function load(): GalaxyState {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as GalaxyState;
    if (saved && Array.isArray(saved.planets)) {
      // reconcile with the current planet roster so adding planets is safe
      const byId = new Map(saved.planets.map((p) => [p.id, p]));
      const planets = PLANETS.map((p) => {
        const s = byId.get(p.id);
        return { ...p, liberation: s?.liberation ?? 0, liberated: s?.liberated ?? false };
      });
      return {
        planets,
        activePlanet: saved.activePlanet ?? PLANETS[0].id,
        missionsWon: saved.missionsWon ?? 0,
        totalKills: saved.totalKills ?? 0,
      };
    }
  } catch {
    /* first run: no file yet */
  }
  return fresh();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 1000);
  saveTimer.unref?.();
}

export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('galaxy save failed:', e);
  }
}

export function galaxyState(): GalaxyState {
  return state;
}

// Apply a won mission: liberate a slice of the active planet (scaled by the
// difficulty's reward multiplier) and bank the squad's kills. Advances the
// front when a planet is fully liberated. Returns what changed for highlighting.
export function contributeWin(xpMult: number, kills: number) {
  state.totalKills += Math.max(0, Math.round(kills));
  state.missionsWon += 1;

  const planet = state.planets.find((p) => p.id === state.activePlanet) ?? state.planets[0];
  const gain = GALAXY.libPerMission * xpMult;
  planet.liberation = Math.min(100, planet.liberation + gain);
  const justLiberated = !planet.liberated && planet.liberation >= 100;
  if (justLiberated) {
    planet.liberated = true;
    const next = state.planets.find((p) => !p.liberated);
    if (next) state.activePlanet = next.id; // front advances; full clear stays put
  }
  scheduleSave();
  return { planet: planet.id, liberation: planet.liberation, liberated: justLiberated };
}
