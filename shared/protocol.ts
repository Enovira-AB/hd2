// Wire protocol: JSON messages discriminated by `type`.
// This file is the single source of truth; the Swift client mirrors it in
// ios/Sources/Protocol.swift. v1 favors debuggability over bandwidth — the
// upgrade path is MessagePack/binary snapshots behind the same shapes.

export type Vec3 = [number, number, number];

export const ANIM = {
  MOVING: 1,
  SPRINT: 2,
  FIRING: 4,
  RELOADING: 8,
  DEAD: 16,
  STRAT: 32, // punching in a stratagem code
  DIVING: 64, // mid dive/dodge roll
} as const;

export interface PlayerState {
  id: string;
  name: string;
  pos: Vec3;
  yaw: number;
  pitch: number;
  anim: number;
  hp: number;
  ammo: number;
  reserve: number;
  kills: number;
  boarded: boolean;
  weapon?: string; // equipped weapon id
  level?: number; // account level (for squad display)
}

// A player's persistent account snapshot, sent on join and after each mission.
export interface ProfileState {
  level: number;
  xp: number; // cumulative lifetime XP
  into: number; // XP earned into the current level
  span: number; // XP the current level spans
  unlocked: string[]; // weapon ids available at this level
  kills: number; // lifetime kills
  missions: number; // lifetime missions completed
}

export interface BugState {
  id: number;
  kind: number; // index into BUG_KINDS
  pos: Vec3;
  yaw: number;
  hp: number;
  flags?: number; // BUGFLAG bits (windup/charging), omitted when 0
}

export const BUGFLAG = {
  WINDUP: 1, // charger telegraphing a lunge
  CHARGING: 2, // charger mid-lunge
} as const;

export interface ProjectileState {
  id: number;
  kind: number; // 0 acid glob (spitter), 1 bile (titan)
  pos: Vec3;
  vel: Vec3; // lets clients extrapolate between snapshots
}

export interface SupplyState {
  id: number;
  pos: Vec3;
  charges: number;
}

export interface SentryState {
  id: number;
  pos: Vec3;
  yaw: number;
  hp: number;
}

export interface FireZoneState {
  id: number;
  pos: Vec3;
  radius: number;
}

export type MissionPhase =
  | 'LOBBY'
  | 'DROP'
  | 'KILL'
  | 'EXTRACT'
  | 'DEFEND'
  | 'BOARD'
  | 'COMPLETE'
  | 'FAILED';

export type MissionObjective = 'ERADICATE' | 'NESTS';

export interface MissionState {
  phase: MissionPhase;
  seed: number;
  objective: MissionObjective;
  kills: number;
  killTarget: number;
  nestsLeft: number; // live bug nests (NESTS objective)
  nestsTotal: number;
  reinforceLeft: number;
  // server clock (ms) when the current phase auto-advances; 0 if not timed
  phaseEndsAt: number;
}

export interface NestState {
  i: number; // index into the layout's nests
  pos: Vec3;
  hp: number;
  hpMax: number;
}

export type ClientMsg =
  | { type: 'join'; v: number; name: string; room?: string; pid?: string } // pid = persistent account id
  | { type: 'start' }
  | { type: 'state'; pos: Vec3; yaw: number; pitch: number; anim: number }
  | { type: 'fire'; origin: Vec3; dir: Vec3 }
  | { type: 'dive'; dir: Vec3 }
  | { type: 'loadout'; weapon: string; stratagems: string[] } // chosen in the lobby
  | { type: 'reload' }
  | { type: 'stratagem'; kind: string; target: Vec3 }
  | { type: 'interact' }
  | { type: 'ping'; t: number };

export type HitKind = 'bug' | 'player' | 'rock' | 'nest' | 'none';

export type ServerMsg =
  | {
      type: 'welcome';
      self: string;
      room: string;
      host: string;
      mission: MissionState;
      players: PlayerState[];
      profile: ProfileState; // the joining player's account
    }
  | { type: 'error'; reason: string }
  | { type: 'joined'; player: PlayerState }
  | { type: 'left'; id: string; host: string }
  | {
      type: 'snapshot';
      t: number; // server clock ms
      players: PlayerState[];
      bugs: BugState[];
      supplies: SupplyState[];
      mission: MissionState;
      projectiles?: ProjectileState[]; // omitted when none in flight
      sentries?: SentryState[]; // deployed auto-turrets
      fires?: FireZoneState[]; // burning napalm zones
      nests?: NestState[]; // live destructible nests
      boss?: { id: number; hp: number; hpMax: number } | null; // titan healthbar
    }
  | { type: 'fired'; id: string; origin: Vec3; dir: Vec3; hit: Vec3 | null; hitKind: HitKind }
  | { type: 'sentryFire'; id: number; from: Vec3; to: Vec3 } // turret tracer
  | { type: 'recon'; pos: Vec3 } // recon pulse ping (clients reveal nearby bugs)
  | { type: 'bugDeath'; id: number; pos: Vec3; kind: number; by?: string } // by = killer player id
  | { type: 'splat'; pos: Vec3; kind: number } // acid projectile impact
  | { type: 'nestDeath'; i: number; pos: Vec3 } // a nest was sealed/destroyed
  | { type: 'boss'; pos: Vec3 } // titan arrival
  | { type: 'hit'; id: string; hp: number } // a player took damage
  | { type: 'down'; id: string }
  | { type: 'strat'; id: string; kind: string; target: Vec3; at: number } // impact at server time
  | { type: 'boom'; kind: string; pos: Vec3 } // ORBITAL | RESUPPLY | REINFORCE | SHUTTLE
  | { type: 'reinforced'; ids: string[]; pos: Vec3 }
  | { type: 'phase'; mission: MissionState }
  | { type: 'boarded'; id: string }
  // post-mission rewards: XP gained (with a breakdown), the updated profile, and
  // any weapons newly unlocked by a level-up this mission.
  | {
      type: 'progress';
      xpGained: number;
      leveledTo?: number; // present only when the player gained a level
      unlockedNew: string[]; // weapon ids newly available
      breakdown: { label: string; xp: number }[];
      profile: ProfileState;
    }
  | { type: 'pong'; t: number; now: number };

export function parseClientMsg(raw: string): ClientMsg | null {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return null;
    return msg as ClientMsg;
  } catch {
    return null;
  }
}
