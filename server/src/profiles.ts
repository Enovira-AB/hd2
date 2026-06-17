// Persistent player accounts. Profiles are keyed by a client-generated id (pid)
// and stored as a single JSON array on disk. Writes are debounced and atomic
// (write-temp-then-rename) so a crash can't leave a half-written file. Tests
// point HD_DATA_DIR at a temp dir to stay isolated and deterministic.

import fs from 'node:fs';
import path from 'node:path';

export interface Profile {
  pid: string;
  name: string;
  xp: number; // cumulative lifetime XP
  kills: number; // lifetime kills
  missions: number; // lifetime missions completed
  created: number;
  updated: number;
}

const dataDir = path.resolve(process.env.HD_DATA_DIR ?? path.join(process.cwd(), 'server', 'data'));
const file = path.join(dataDir, 'profiles.json');

const profiles = new Map<string, Profile>();

(function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile[];
    if (Array.isArray(arr)) for (const p of arr) if (p && typeof p.pid === 'string') profiles.set(p.pid, p);
  } catch {
    /* first run: no file yet */
  }
})();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 1000);
  saveTimer.unref?.(); // never keep the process alive just to flush
}

// Force any pending changes to disk now (atomic replace).
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
    fs.writeFileSync(tmp, JSON.stringify([...profiles.values()]));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('profile save failed:', e);
  }
}

// Fetch the account for a pid, creating a fresh one if unseen. An updated name
// is adopted so a player's latest callsign sticks.
export function getProfile(pid: string, name: string): Profile {
  let p = profiles.get(pid);
  if (!p) {
    p = { pid, name, xp: 0, kills: 0, missions: 0, created: Date.now(), updated: Date.now() };
    profiles.set(pid, p);
  }
  if (name) p.name = name;
  return p;
}

// Persist changes a caller has already applied to a profile object.
export function saveProfile(p: Profile) {
  p.updated = Date.now();
  scheduleSave();
}
