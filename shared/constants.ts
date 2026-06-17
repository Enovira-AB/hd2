// Game tuning shared by server and clients.
// The Swift client mirrors these values in ios/Sources/Constants.swift —
// keep them in sync when changing anything here.

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30; // server simulation Hz
export const SNAPSHOT_RATE = 15; // state broadcast Hz
export const CLIENT_SEND_RATE = 20; // client -> server state Hz
export const INTERP_DELAY_MS = 120; // remote entities render this far in the past

export const MAP_HALF = 110; // playable half-extent in meters
export const MAX_PLAYERS = 4;

export const WALK_SPEED = 5.2;
export const SPRINT_SPEED = 8.4;
// Server tolerates this factor above sprint speed before snapping a player back.
export const SPEED_TOLERANCE = 1.45;

export const PLAYER_MAX_HP = 100;
export const PLAYER_RADIUS = 0.45;
export const REGEN_DELAY_S = 6;
export const REGEN_PER_S = 9;

// Dive/dodge roll: a fast server-driven lunge with brief invulnerability —
// the counter to charger lunges and getting swarmed.
export const DIVE = { speed: 12.5, durationS: 0.45, cooldownS: 1.3 } as const;

export const RIFLE = {
  damage: 34,
  magSize: 30,
  reserveMax: 240,
  fireInterval: 0.1, // 600 rpm
  range: 140,
  reloadTime: 2.2,
} as const;

// Primary weapons. The rifle keeps RIFLE's stats so existing behaviour/tests
// are unchanged when no loadout is chosen.
export interface WeaponDef {
  id: string;
  name: string;
  damage: number;
  magSize: number;
  reserveMax: number;
  fireInterval: number; // seconds between shots
  range: number;
  reloadTime: number;
  spread: number; // radians of cone (per pellet)
  pellets: number; // >1 for shotguns
  auto: boolean; // hold to fire vs tap
  unlockLevel: number;
}

export const WEAPONS: WeaponDef[] = [
  { id: 'rifle', name: 'AR-23 Liberator', damage: 34, magSize: 30, reserveMax: 240, fireInterval: 0.1, range: 140, reloadTime: 2.2, spread: 0.012, pellets: 1, auto: true, unlockLevel: 0 },
  { id: 'smg', name: 'MP-98 Knight', damage: 22, magSize: 45, reserveMax: 270, fireInterval: 0.07, range: 80, reloadTime: 1.9, spread: 0.03, pellets: 1, auto: true, unlockLevel: 2 },
  { id: 'shotgun', name: 'SG-8 Punisher', damage: 15, magSize: 8, reserveMax: 64, fireInterval: 0.5, range: 36, reloadTime: 2.8, spread: 0.11, pellets: 9, auto: false, unlockLevel: 3 },
  { id: 'mg', name: 'MG-43 Stalwart', damage: 30, magSize: 100, reserveMax: 400, fireInterval: 0.055, range: 120, reloadTime: 4.2, spread: 0.05, pellets: 1, auto: true, unlockLevel: 5 },
  { id: 'sniper', name: 'R-63 Diligence', damage: 115, magSize: 12, reserveMax: 96, fireInterval: 0.34, range: 250, reloadTime: 2.6, spread: 0.002, pellets: 1, auto: false, unlockLevel: 7 },
];

export function weaponById(id: string): WeaponDef {
  return WEAPONS.find((w) => w.id === id) ?? WEAPONS[0];
}

// Progression: kills + mission completion earn XP; XP raises your level; levels
// unlock weapons (WeaponDef.unlockLevel). Players start at level 1.
export const PROGRESSION = {
  // XP per kill, indexed by BUG_KINDS: scavenger, warrior, spitter, charger, titan
  killXp: [2, 6, 5, 18, 80] as number[],
  nestXp: 14, // sealing a nest
  missionXp: 130, // bonus for completing a mission
  failXpFactor: 0.35, // fraction of earned combat XP kept on a failed mission
} as const;

// XP needed to advance FROM `level` to the next one. Cheap early, then steeper,
// so the first few unlocks come within a mission or two.
export function xpToNext(level: number): number {
  return 120 + 40 * (level - 1);
}

// Resolve cumulative XP into a level and progress within that level.
export function levelForXp(xp: number): { level: number; into: number; span: number } {
  let level = 1;
  let rem = Math.max(0, Math.floor(xp));
  // guard against pathological inputs; 200 levels is far beyond the unlock range
  while (level < 200 && rem >= xpToNext(level)) {
    rem -= xpToNext(level);
    level++;
  }
  return { level, into: rem, span: xpToNext(level) };
}

// Weapon ids unlocked at or below a given level (rifle is always available).
export function unlockedWeapons(level: number): string[] {
  return WEAPONS.filter((w) => level >= w.unlockLevel).map((w) => w.id);
}

// Difficulty tiers scale the whole mission. The baseline tier (CHALLENGING)
// leaves everything at ×1 so the default game is unchanged; harder tiers add
// more, tougher, heavier enemies and pay out more XP. Tiers unlock with rank.
export interface DifficultyDef {
  id: number; // 1..N, shown to players
  name: string;
  bugCapMult: number; // concurrent enemy cap
  spawnMult: number; // ×spawn interval (<1 = spawns come faster)
  hpMult: number; // enemy health
  dmgMult: number; // enemy damage
  heavyBias: number; // 0..1, shifts the spawn table toward warriors/chargers
  killMult: number; // eradicate quota
  xpMult: number; // reward payout
  unlockLevel: number; // account rank required to select
}

export const DIFFICULTIES: DifficultyDef[] = [
  { id: 1, name: 'TRIVIAL',     bugCapMult: 0.7, spawnMult: 1.35, hpMult: 0.85, dmgMult: 0.7,  heavyBias: 0.0,  killMult: 0.7, xpMult: 0.7, unlockLevel: 1 },
  { id: 2, name: 'CHALLENGING', bugCapMult: 1.0, spawnMult: 1.0,  hpMult: 1.0,  dmgMult: 1.0,  heavyBias: 0.1,  killMult: 1.0, xpMult: 1.0, unlockLevel: 1 },
  { id: 3, name: 'HARD',        bugCapMult: 1.3, spawnMult: 0.82, hpMult: 1.25, dmgMult: 1.2,  heavyBias: 0.25, killMult: 1.3, xpMult: 1.5, unlockLevel: 3 },
  { id: 4, name: 'EXTREME',     bugCapMult: 1.6, spawnMult: 0.68, hpMult: 1.55, dmgMult: 1.45, heavyBias: 0.4,  killMult: 1.6, xpMult: 2.1, unlockLevel: 5 },
  { id: 5, name: 'HELLDIVE',    bugCapMult: 2.0, spawnMult: 0.55, hpMult: 2.0,  dmgMult: 1.8,  heavyBias: 0.6,  killMult: 2.0, xpMult: 3.0, unlockLevel: 8 },
];

export function difficultyById(id: number): DifficultyDef {
  return DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[1]; // default: CHALLENGING (×1)
}

export interface BugKindDef {
  name: string;
  hp: number;
  speed: number;
  damage: number; // melee damage
  attackRange: number;
  attackCooldown: number;
  radius: number;
  ranged?: boolean; // attacks with acid projectiles instead of (or beyond) melee
  preferredRange?: number; // ranged kinds try to hold this distance
  projDamage?: number;
  charge?: boolean; // winds up and lunges
  boss?: boolean; // huge, healthbar, special attacks, counts big toward the quota
}

// kind index into this array is what travels over the wire. Append only —
// never reorder, or every client renders the wrong creature.
export const BUG_KINDS: BugKindDef[] = [
  { name: 'scavenger', hp: 30, speed: 6.4, damage: 8, attackRange: 1.6, attackCooldown: 0.9, radius: 0.55 },
  { name: 'warrior', hp: 130, speed: 4.6, damage: 17, attackRange: 2.0, attackCooldown: 1.2, radius: 0.85 },
  { name: 'spitter', hp: 70, speed: 3.4, damage: 0, attackRange: 32, attackCooldown: 2.6, radius: 0.72,
    ranged: true, preferredRange: 18, projDamage: 18 },
  { name: 'charger', hp: 360, speed: 5.0, damage: 34, attackRange: 3.0, attackCooldown: 2.2, radius: 1.15,
    charge: true },
  { name: 'titan', hp: 3200, speed: 2.3, damage: 55, attackRange: 6.5, attackCooldown: 2.4, radius: 3.4,
    ranged: true, preferredRange: 0, projDamage: 26, boss: true },
];
export const BUG_AGGRO_RANGE = 60;
export const BUG_SEPARATION = 1.25;

// Acid globs flung by spitters and the titan.
export const PROJECTILE = { speed: 27, gravity: 9.5, radius: 0.6, ttlS: 4 } as const;

// Charger lunge: stop and telegraph, then burst straight ahead.
export const CHARGE = { windupS: 0.45, lungeS: 0.7, speedMult: 3.1, minRange: 6, maxRange: 22, knockback: 4 } as const;

// Titan stomp shockwave (close-range AOE).
export const TITAN_STOMP = { radius: 6.5, damage: 42 } as const;

// Boss arrival: once the squad is halfway to quota on a long enough mission.
export const BOSS = { triggerFrac: 0.5, minKillTarget: 12, killReward: 8 } as const;

// Destructible bug nests. On NESTS missions, sealing them all is the objective.
export const NEST = { hp: 600 } as const;

// Relative spawn weights per kind, ramped by mission progress (0..1).
export function spawnWeights(progress: number): number[] {
  // scavenger, warrior, spitter, charger  (titan never spawns from the pool)
  const t = Math.max(0, Math.min(1, progress));
  return [
    0.46 - 0.20 * t, // scavengers thin out as it heats up
    0.24, // warrior (Maw)
    0.10 + 0.06 * t, // more spitters later
    0.20 + 0.14 * t, // charger (Warrok) — weighted up so the brute actually shows
  ];
}

// Arrow codes use U/D/L/R characters.
export const STRATAGEMS = {
  REINFORCE: { code: 'UDRLU', deployDelayS: 2.2, label: 'Reinforce' },
  ORBITAL: { code: 'RRU', deployDelayS: 3.0, label: 'Orbital Strike' },
  RESUPPLY: { code: 'DDUR', deployDelayS: 2.5, label: 'Resupply' },
  SENTRY: { code: 'DURU', deployDelayS: 2.0, label: 'Sentry Gun' },
  NAPALM: { code: 'RRDU', deployDelayS: 2.8, label: 'Napalm Barrage' },
  RECON: { code: 'UUD', deployDelayS: 0.4, label: 'Recon Pulse' },
} as const;
export type StratagemKind = keyof typeof STRATAGEMS;
export const ORBITAL_RADIUS = 9;
export const ORBITAL_DAMAGE = 420; // friendly fire applies

// Auto-turret: targets the nearest bug in range and chips it down.
export const SENTRY = { hp: 90, lifetimeS: 45, range: 42, fireInterval: 0.16, damage: 26 } as const;
// Burning area denial; damages bugs and players standing in it (friendly fire).
export const NAPALM = { radius: 8, durationS: 6, dps: 55 } as const;
// Sweeps the dark: pings every bug within range so the squad sees them.
export const RECON = { range: 95, durationS: 6 } as const;

export const MISSION = {
  killBase: 15,
  killPerExtraPlayer: 10,
  reinforceBase: 4,
  reinforcePerExtraPlayer: 2,
  bugCapBase: 14,
  bugCapPerExtraPlayer: 7,
  defendCapMult: 1.7,
  spawnIntervalS: 1.1,
  dropDurationS: 3,
  defendDurationS: 75,
  boardGraceS: 18,
  resetDelayS: 8,
  extractPadRadius: 7,
  supplyCharges: 4,
} as const;
