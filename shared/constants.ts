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

export const RIFLE = {
  damage: 34,
  magSize: 30,
  reserveMax: 240,
  fireInterval: 0.1, // 600 rpm
  range: 140,
  reloadTime: 2.2,
} as const;

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
