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
  damage: number;
  attackRange: number;
  attackCooldown: number;
  radius: number;
}

// kind index into this array is what travels over the wire
export const BUG_KINDS: BugKindDef[] = [
  { name: 'scavenger', hp: 30, speed: 6.4, damage: 8, attackRange: 1.6, attackCooldown: 0.9, radius: 0.55 },
  { name: 'warrior', hp: 130, speed: 4.6, damage: 17, attackRange: 2.0, attackCooldown: 1.2, radius: 0.85 },
];
export const BUG_AGGRO_RANGE = 55;
export const BUG_SEPARATION = 1.25;

// Arrow codes use U/D/L/R characters.
export const STRATAGEMS = {
  REINFORCE: { code: 'UDRLU', deployDelayS: 2.2, label: 'Reinforce' },
  ORBITAL: { code: 'RRU', deployDelayS: 3.0, label: 'Orbital Strike' },
  RESUPPLY: { code: 'DDUR', deployDelayS: 2.5, label: 'Resupply' },
} as const;
export type StratagemKind = keyof typeof STRATAGEMS;
export const ORBITAL_RADIUS = 9;
export const ORBITAL_DAMAGE = 420; // friendly fire applies

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
