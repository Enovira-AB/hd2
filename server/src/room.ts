import type { WebSocket } from 'ws';
import {
  ANIM,
  type BugState,
  type ClientMsg,
  type FireZoneState,
  type MissionState,
  type PlayerState,
  type ProjectileState,
  type SentryState,
  type ServerMsg,
  type Vec3,
} from '../../shared/protocol.js';
import {
  BOSS,
  BUG_KINDS,
  DIVE,
  MAP_HALF,
  MAX_PLAYERS,
  MISSION,
  NAPALM,
  ORBITAL_DAMAGE,
  ORBITAL_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PROJECTILE,
  RECON,
  REGEN_DELAY_S,
  REGEN_PER_S,
  RIFLE,
  SENTRY,
  SPEED_TOLERANCE,
  SPRINT_SPEED,
  STRATAGEMS,
  TICK_RATE,
  spawnWeights,
  type StratagemKind,
} from '../../shared/constants.js';
import {
  generateLayout,
  mulberry32,
  raycastRocks,
  resolveCollisions,
  terrainHeight,
  type WorldLayout,
} from '../../shared/world.js';
import { hitscan, tickBugs, type ProjSpawn, type SBug, type SPlayer } from './sim.js';

interface SProjectile {
  id: number;
  kind: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  damage: number;
  dieAt: number;
}

interface SSentry {
  id: number;
  x: number; y: number; z: number;
  yaw: number;
  hp: number;
  dieAt: number;
  fireReadyAt: number;
  owner: string;
}

interface SFire {
  id: number;
  x: number; z: number;
  radius: number;
  dieAt: number;
}

interface PendingStrat {
  kind: StratagemKind;
  target: Vec3;
  at: number;
  by: string;
}

interface Supply {
  id: number;
  pos: Vec3;
  charges: number;
}

// Test hook: HD_MISSION_OVERRIDES='{"killBase":2,...}' compresses mission
// pacing so integration tests can play a full mission in seconds.
const M: typeof MISSION = (() => {
  try {
    return { ...MISSION, ...JSON.parse(process.env.HD_MISSION_OVERRIDES ?? '{}') };
  } catch {
    return MISSION;
  }
})();

let nextEntityId = 1;

export class Room {
  readonly code: string;
  private sockets = new Map<WebSocket, SPlayer>();
  private players = new Map<string, SPlayer>();
  private bugs = new Map<number, SBug>();
  private projectiles = new Map<number, SProjectile>();
  private sentries = new Map<number, SSentry>();
  private fires = new Map<number, SFire>();
  private supplies = new Map<number, Supply>();
  private pendingStrats: PendingStrat[] = [];
  private titanId = 0; // bug id of the live titan, 0 if none
  private titanSpawned = false; // already arrived this mission
  private mission: MissionState;
  private layout: WorldLayout;
  private hostId = '';
  private rng: () => number;
  private nextSpawnAt = 0;
  private resetAt = 0;
  private tickTimer: NodeJS.Timeout;
  private snapshotToggle = false;
  private lastTick = Date.now();
  onEmpty: () => void = () => {};

  constructor(code: string) {
    this.code = code;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.mission = {
      phase: 'LOBBY',
      seed,
      kills: 0,
      killTarget: 0,
      reinforceLeft: 0,
      phaseEndsAt: 0,
    };
    this.layout = generateLayout(seed);
    this.rng = mulberry32(seed ^ 0xbeef);
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  dispose() {
    clearInterval(this.tickTimer);
  }

  get size() {
    return this.players.size;
  }

  // ---- lifecycle -----------------------------------------------------------

  addPlayer(ws: WebSocket, name: string): SPlayer | null {
    if (this.players.size >= MAX_PLAYERS) {
      this.sendTo(ws, { type: 'error', reason: 'Squad is full' });
      return null;
    }
    const id = (nextEntityId++).toString(36) + Math.floor(this.rng() * 36).toString(36);
    const spawn = this.spawnPoint();
    const player: SPlayer = {
      id,
      name: name.slice(0, 16) || 'Helldiver',
      pos: spawn,
      yaw: 0,
      pitch: 0,
      anim: 0,
      hp: PLAYER_MAX_HP,
      ammo: RIFLE.magSize,
      reserve: RIFLE.reserveMax,
      kills: 0,
      alive: true,
      boarded: false,
      lastFireAt: 0,
      reloadEndAt: 0,
      pendingReload: false,
      lastDamageAt: 0,
      lastStateAt: Date.now(),
      diveUntil: 0,
      diveReadyAt: 0,
      diveDx: 0,
      diveDz: 0,
    };
    this.sockets.set(ws, player);
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;

    this.sendTo(ws, {
      type: 'welcome',
      self: id,
      room: this.code,
      host: this.hostId,
      mission: this.mission,
      players: this.playerStates(),
    });
    this.broadcast({ type: 'joined', player: this.playerState(player) }, ws);
    if (this.missionActive()) {
      // hot join: announce a hellpod at the spawn point
      this.broadcast({ type: 'boom', kind: 'HELLPOD', pos: spawn });
    }
    return player;
  }

  removeSocket(ws: WebSocket) {
    const player = this.sockets.get(ws);
    if (!player) return;
    this.sockets.delete(ws);
    this.players.delete(player.id);
    if (this.hostId === player.id) {
      this.hostId = this.players.keys().next().value ?? '';
    }
    this.broadcast({ type: 'left', id: player.id, host: this.hostId });
    if (this.players.size === 0) this.onEmpty();
  }

  handle(ws: WebSocket, msg: ClientMsg) {
    const player = this.sockets.get(ws);
    if (!player) return;
    switch (msg.type) {
      case 'start':
        if (player.id === this.hostId && !this.missionActive()) this.startMission();
        break;
      case 'state':
        this.handleState(player, msg.pos, msg.yaw, msg.pitch, msg.anim);
        break;
      case 'dive':
        this.handleDive(player, msg.dir);
        break;
      case 'fire':
        this.handleFire(player, msg.origin, msg.dir);
        break;
      case 'reload':
        this.handleReload(player);
        break;
      case 'stratagem':
        this.handleStratagem(player, msg.kind, msg.target);
        break;
      case 'interact':
        this.handleInteract(player);
        break;
      case 'ping':
        this.sendTo(ws, { type: 'pong', t: msg.t, now: Date.now() });
        break;
    }
  }

  // ---- mission machine -----------------------------------------------------

  private missionActive() {
    const p = this.mission.phase;
    return p !== 'LOBBY' && p !== 'COMPLETE' && p !== 'FAILED';
  }

  private startMission() {
    const now = Date.now();
    const n = this.players.size;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.mission = {
      phase: 'DROP',
      seed,
      kills: 0,
      killTarget: M.killBase + M.killPerExtraPlayer * (n - 1),
      reinforceLeft: M.reinforceBase + M.reinforcePerExtraPlayer * (n - 1),
      phaseEndsAt: now + M.dropDurationS * 1000,
    };
    this.layout = generateLayout(seed);
    this.rng = mulberry32(seed ^ 0xbeef);
    this.bugs.clear();
    this.projectiles.clear();
    this.sentries.clear();
    this.fires.clear();
    this.supplies.clear();
    this.pendingStrats = [];
    this.titanId = 0;
    this.titanSpawned = false;
    this.nextSpawnAt = now;
    let i = 0;
    for (const p of this.players.values()) {
      this.resetPlayer(p, this.spawnPoint(i++));
    }
    const cap = this.bugCap();
    for (let k = 0; k < Math.floor(cap * 0.5); k++) this.spawnBug();
    this.broadcastPhase();
  }

  private resetPlayer(p: SPlayer, pos: Vec3) {
    p.pos = pos;
    p.hp = PLAYER_MAX_HP;
    p.ammo = RIFLE.magSize;
    p.reserve = RIFLE.reserveMax;
    p.alive = true;
    p.boarded = false;
    p.anim = 0;
    p.pendingReload = false;
    p.kills = 0;
    p.diveUntil = 0;
    p.diveReadyAt = 0;
  }

  private spawnPoint(index = 0): Vec3 {
    const ang = (index / MAX_PLAYERS) * Math.PI * 2;
    const x = Math.cos(ang) * 2.2;
    const z = Math.sin(ang) * 2.2;
    return [x, terrainHeight(this.mission.seed, x, z), z];
  }

  private setPhase(phase: MissionState['phase'], endsInS = 0) {
    this.mission.phase = phase;
    this.mission.phaseEndsAt = endsInS > 0 ? Date.now() + endsInS * 1000 : 0;
    if (phase === 'COMPLETE' || phase === 'FAILED') {
      this.resetAt = Date.now() + M.resetDelayS * 1000;
    }
    this.broadcastPhase();
  }

  private broadcastPhase() {
    this.broadcast({ type: 'phase', mission: this.mission });
  }

  private bugCap() {
    const n = Math.max(1, this.players.size);
    const base = M.bugCapBase + M.bugCapPerExtraPlayer * (n - 1);
    return this.mission.phase === 'DEFEND' ? Math.floor(base * M.defendCapMult) : base;
  }

  // ---- message handlers ----------------------------------------------------

  private handleState(p: SPlayer, pos: Vec3, yaw: number, pitch: number, anim: number) {
    const now = Date.now();
    if (!p.alive || p.boarded) {
      p.lastStateAt = now;
      return;
    }
    const dt = Math.max(0.01, (now - p.lastStateAt) / 1000);
    p.lastStateAt = now;
    // the server owns position during a dive; ignore client pos until it ends
    if (now >= p.diveUntil) {
      const dist = Math.hypot(pos[0] - p.pos[0], pos[2] - p.pos[2]);
      if (dist <= SPRINT_SPEED * SPEED_TOLERANCE * dt + 0.6) {
        const [x, z] = resolveCollisions(pos[0], pos[2], PLAYER_RADIUS, this.layout.rocks);
        p.pos = [x, terrainHeight(this.mission.seed, x, z), z];
      }
    }
    p.yaw = yaw;
    p.pitch = Math.max(-1.4, Math.min(1.4, pitch));
    p.anim = (anim & ~ANIM.DEAD) | (p.alive ? 0 : ANIM.DEAD);
  }

  private handleDive(p: SPlayer, dir: Vec3) {
    const now = Date.now();
    if (!p.alive || p.boarded || !this.missionActive()) return;
    if (now < p.diveReadyAt || now < p.diveUntil) return;
    const len = Math.hypot(dir[0], dir[2]) || 1;
    p.diveDx = dir[0] / len;
    p.diveDz = dir[2] / len;
    p.diveUntil = now + DIVE.durationS * 1000;
    p.diveReadyAt = now + DIVE.cooldownS * 1000;
  }

  private handleFire(p: SPlayer, origin: Vec3, dir: Vec3) {
    const now = Date.now();
    if (!p.alive || p.boarded || !this.missionActive()) return;
    if (now < p.reloadEndAt || p.ammo <= 0) return;
    if (now - p.lastFireAt < RIFLE.fireInterval * 800) return;
    p.lastFireAt = now;
    p.ammo--;

    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
    const eye: Vec3 = [p.pos[0], p.pos[1] + 1.55, p.pos[2]];
    const off = Math.hypot(origin[0] - eye[0], origin[1] - eye[1], origin[2] - eye[2]);
    const o = off < 3 ? origin : eye;

    const hit = hitscan(p, o, d, this.mission.seed, this.layout, this.bugs.values(), this.players.values());
    if (hit.kind === 'bug' && hit.bug) {
      hit.bug.hp -= RIFLE.damage;
      hit.bug.aggro = true;
      if (hit.bug.hp <= 0) this.killBug(hit.bug, p);
    } else if (hit.kind === 'player' && hit.player) {
      this.damagePlayer(hit.player, RIFLE.damage); // friendly fire: a Helldivers tradition
    }
    this.broadcast({
      type: 'fired',
      id: p.id,
      origin: o,
      dir: d,
      hit: hit.kind === 'none' ? null : hit.point,
      hitKind: hit.kind,
    });
  }

  private handleReload(p: SPlayer) {
    const now = Date.now();
    if (!p.alive || p.pendingReload || p.ammo >= RIFLE.magSize || p.reserve <= 0) return;
    p.pendingReload = true;
    p.reloadEndAt = now + RIFLE.reloadTime * 1000;
  }

  private handleStratagem(p: SPlayer, kind: string, target: Vec3) {
    if (!p.alive || p.boarded || !this.missionActive()) return;
    if (!(kind in STRATAGEMS)) return;
    const k = kind as StratagemKind;
    if (k === 'REINFORCE') {
      const anyDead = [...this.players.values()].some((q) => !q.alive);
      if (!anyDead || this.mission.reinforceLeft <= 0) return;
    }
    const dist = Math.hypot(target[0] - p.pos[0], target[2] - p.pos[2]);
    if (dist > 45) return;
    const x = Math.max(-100, Math.min(100, target[0]));
    const z = Math.max(-100, Math.min(100, target[2]));
    const t: Vec3 = [x, terrainHeight(this.mission.seed, x, z), z];
    const at = Date.now() + STRATAGEMS[k].deployDelayS * 1000;
    this.pendingStrats.push({ kind: k, target: t, at, by: p.id });
    this.broadcast({ type: 'strat', id: p.id, kind: k, target: t, at });
  }

  private handleInteract(p: SPlayer) {
    if (!p.alive || p.boarded) return;
    for (const s of this.supplies.values()) {
      if (Math.hypot(s.pos[0] - p.pos[0], s.pos[2] - p.pos[2]) < 2.4 && s.charges > 0) {
        s.charges--;
        p.reserve = RIFLE.reserveMax;
        p.hp = Math.min(PLAYER_MAX_HP, p.hp + 25);
        if (s.charges <= 0) this.supplies.delete(s.id);
        return;
      }
    }
    const pad = this.layout.pad;
    const distPad = Math.hypot(pad.x - p.pos[0], pad.z - p.pos[2]);
    if (this.mission.phase === 'EXTRACT' && distPad < M.extractPadRadius) {
      this.setPhase('DEFEND', M.defendDurationS);
    } else if (this.mission.phase === 'BOARD' && distPad < M.extractPadRadius + 2) {
      p.boarded = true;
      this.broadcast({ type: 'boarded', id: p.id });
      const alive = [...this.players.values()].filter((q) => q.alive);
      if (alive.length > 0 && alive.every((q) => q.boarded)) this.setPhase('COMPLETE');
    }
  }

  private damagePlayer(p: SPlayer, dmg: number) {
    if (!p.alive || p.boarded) return;
    if (Date.now() < p.diveUntil) return; // i-frames: a well-timed dive dodges
    p.hp -= dmg;
    p.lastDamageAt = Date.now();
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      p.anim |= ANIM.DEAD;
      this.broadcast({ type: 'down', id: p.id });
    } else {
      this.broadcast({ type: 'hit', id: p.id, hp: p.hp });
    }
  }

  // ---- tick ----------------------------------------------------------------

  private tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const m = this.mission;

    if (m.phase === 'DROP' && now >= m.phaseEndsAt) this.setPhase('KILL');
    if (m.phase === 'KILL' && m.kills >= m.killTarget) this.setPhase('EXTRACT');
    if (m.phase === 'DEFEND' && now >= m.phaseEndsAt) {
      this.setPhase('BOARD', M.boardGraceS);
      const pad = this.layout.pad;
      this.broadcast({
        type: 'boom',
        kind: 'SHUTTLE',
        pos: [pad.x, terrainHeight(m.seed, pad.x, pad.z), pad.z],
      });
    }
    if (m.phase === 'BOARD' && now >= m.phaseEndsAt) {
      const anyBoarded = [...this.players.values()].some((p) => p.boarded);
      this.setPhase(anyBoarded ? 'COMPLETE' : 'FAILED');
    }
    if ((m.phase === 'COMPLETE' || m.phase === 'FAILED') && now >= this.resetAt) {
      this.setPhase('LOBBY');
      this.bugs.clear();
      this.projectiles.clear();
      this.sentries.clear();
      this.fires.clear();
      this.supplies.clear();
      this.pendingStrats = [];
      this.titanId = 0;
      this.titanSpawned = false;
      let i = 0;
      for (const p of this.players.values()) this.resetPlayer(p, this.spawnPoint(i++));
    }

    if (this.missionActive() && this.players.size > 0) {
      const everyoneDown = [...this.players.values()].every((p) => !p.alive || p.boarded);
      const anyAlive = [...this.players.values()].some((p) => p.alive);
      if (!anyAlive && everyoneDown) this.setPhase('FAILED');
    }

    if (this.missionActive() && m.phase !== 'DROP') {
      const interval = m.phase === 'DEFEND' ? M.spawnIntervalS * 550 : M.spawnIntervalS * 1000;
      if (now >= this.nextSpawnAt && this.bugs.size < this.bugCap()) {
        this.spawnBug();
        this.nextSpawnAt = now + interval;
      }
      // titan arrives once the squad is halfway through a long enough quota
      if (m.phase === 'KILL' && !this.titanSpawned &&
          m.killTarget >= BOSS.minKillTarget && m.kills >= m.killTarget * BOSS.triggerFrac) {
        this.spawnTitan();
      }
    }

    if (this.missionActive()) {
      const players = [...this.players.values()];

      // advance any in-progress dives (server-authoritative lunge)
      for (const p of players) {
        if (!p.alive || now >= p.diveUntil) continue;
        const nx = p.pos[0] + p.diveDx * DIVE.speed * dt;
        const nz = p.pos[2] + p.diveDz * DIVE.speed * dt;
        const [x, z] = resolveCollisions(nx, nz, PLAYER_RADIUS, this.layout.rocks);
        p.pos = [x, terrainHeight(m.seed, x, z), z];
      }

      const { attacks, projectiles, stomps } = tickBugs(
        this.bugs.values(), players, m.seed, this.layout, dt, now, this.rng,
      );
      for (const a of attacks) this.damagePlayer(a.player, a.damage);
      for (const ps of projectiles) this.spawnProjectile(ps);
      for (const s of stomps) {
        this.broadcast({ type: 'boom', kind: 'STOMP', pos: [s.x, terrainHeight(m.seed, s.x, s.z), s.z] });
        for (const p of players) {
          const d = Math.hypot(p.pos[0] - s.x, p.pos[2] - s.z);
          if (d <= s.radius) this.damagePlayer(p, s.damage * (1 - (d / s.radius) * 0.5));
        }
      }
      this.tickProjectiles(dt, now);
      this.tickSentries(now);
      this.tickFires(dt, now);

      for (const p of players) {
        if (p.pendingReload && now >= p.reloadEndAt) {
          p.pendingReload = false;
          const take = Math.min(RIFLE.magSize - p.ammo, p.reserve);
          p.ammo += take;
          p.reserve -= take;
        }
        if (p.alive && p.hp < PLAYER_MAX_HP && now - p.lastDamageAt > REGEN_DELAY_S * 1000) {
          p.hp = Math.min(PLAYER_MAX_HP, p.hp + REGEN_PER_S * dt);
        }
      }
      this.resolveStrats(now);
    }

    this.snapshotToggle = !this.snapshotToggle;
    if (this.snapshotToggle) this.broadcastSnapshot(now);
  }

  private resolveStrats(now: number) {
    const due = this.pendingStrats.filter((s) => now >= s.at);
    if (due.length === 0) return;
    this.pendingStrats = this.pendingStrats.filter((s) => now < s.at);
    for (const s of due) {
      this.broadcast({ type: 'boom', kind: s.kind, pos: s.target });
      if (s.kind === 'ORBITAL') {
        for (const bug of [...this.bugs.values()]) {
          const d = Math.hypot(bug.x - s.target[0], bug.z - s.target[2]);
          if (d > ORBITAL_RADIUS) continue;
          bug.hp -= ORBITAL_DAMAGE * (1 - (d / ORBITAL_RADIUS) * 0.6);
          if (bug.hp <= 0) this.killBug(bug, this.players.get(s.by) ?? null);
        }
        for (const p of this.players.values()) {
          const d = Math.hypot(p.pos[0] - s.target[0], p.pos[2] - s.target[2]);
          if (d <= ORBITAL_RADIUS) {
            this.damagePlayer(p, ORBITAL_DAMAGE * (1 - (d / ORBITAL_RADIUS) * 0.6));
          }
        }
      } else if (s.kind === 'RESUPPLY') {
        const id = nextEntityId++;
        this.supplies.set(id, { id, pos: s.target, charges: M.supplyCharges });
      } else if (s.kind === 'REINFORCE') {
        const dead = [...this.players.values()].filter((p) => !p.alive);
        const n = Math.min(dead.length, this.mission.reinforceLeft);
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const p = dead[i];
          const ang = (i / Math.max(1, n)) * Math.PI * 2;
          const x = s.target[0] + Math.cos(ang) * 1.6;
          const z = s.target[2] + Math.sin(ang) * 1.6;
          p.pos = [x, terrainHeight(this.mission.seed, x, z), z];
          p.alive = true;
          p.hp = PLAYER_MAX_HP;
          p.ammo = RIFLE.magSize;
          p.reserve = Math.max(p.reserve, RIFLE.reserveMax / 2);
          p.anim &= ~ANIM.DEAD;
          ids.push(p.id);
        }
        this.mission.reinforceLeft -= n;
        if (n > 0) this.broadcast({ type: 'reinforced', ids, pos: s.target });
      } else if (s.kind === 'SENTRY') {
        const id = nextEntityId++;
        this.sentries.set(id, {
          id,
          x: s.target[0],
          y: terrainHeight(this.mission.seed, s.target[0], s.target[2]),
          z: s.target[2],
          yaw: 0,
          hp: SENTRY.hp,
          dieAt: now + SENTRY.lifetimeS * 1000,
          fireReadyAt: now + 400,
          owner: s.by,
        });
      } else if (s.kind === 'NAPALM') {
        const id = nextEntityId++;
        this.fires.set(id, {
          id,
          x: s.target[0],
          z: s.target[2],
          radius: NAPALM.radius,
          dieAt: now + NAPALM.durationS * 1000,
        });
      } else if (s.kind === 'RECON') {
        this.broadcast({ type: 'recon', pos: s.target });
      }
    }
  }

  private spawnBug() {
    if (this.layout.nests.length === 0) return;
    const nestIdx = Math.floor(this.rng() * this.layout.nests.length);
    const nest = this.layout.nests[nestIdx];
    const progress = this.mission.killTarget > 0 ? this.mission.kills / this.mission.killTarget : 0;
    const w = spawnWeights(progress);
    let r = this.rng() * w.reduce((a, b) => a + b, 0);
    let kind = 0;
    for (let k = 0; k < w.length; k++) {
      if (r < w[k]) { kind = k; break; }
      r -= w[k];
    }
    this.addBug(kind, nest.x + (this.rng() * 2 - 1) * 4, nest.z + (this.rng() * 2 - 1) * 4, nestIdx);
  }

  private addBug(kind: number, x: number, z: number, nestIdx: number): SBug {
    const id = nextEntityId++;
    const bug: SBug = {
      id, kind, x, z,
      yaw: this.rng() * Math.PI * 2,
      hp: BUG_KINDS[kind].hp,
      aggro: false,
      nest: nestIdx,
      targetX: x,
      targetZ: z,
      wanderUntil: 0,
      attackReadyAt: 0,
      flags: 0,
      windupUntil: 0,
      chargeUntil: 0,
      chargeDx: 0,
      chargeDz: 0,
    };
    this.bugs.set(id, bug);
    return bug;
  }

  private spawnTitan() {
    this.titanSpawned = true;
    const nest = this.layout.nests[Math.floor(this.rng() * this.layout.nests.length)] ?? { x: 0, z: -90 };
    const bug = this.addBug(4, nest.x, nest.z, 0);
    bug.aggro = true;
    this.titanId = bug.id;
    this.broadcast({
      type: 'boss',
      pos: [bug.x, terrainHeight(this.mission.seed, bug.x, bug.z), bug.z],
    });
  }

  private killBug(bug: SBug, killer: SPlayer | null) {
    if (!this.bugs.has(bug.id)) return;
    this.bugs.delete(bug.id);
    const reward = BUG_KINDS[bug.kind].boss ? BOSS.killReward : 1;
    this.mission.kills += reward;
    if (killer) killer.kills += reward;
    if (bug.id === this.titanId) this.titanId = 0;
    this.broadcast({
      type: 'bugDeath',
      id: bug.id,
      pos: [bug.x, bugY(this.mission.seed, bug), bug.z],
      kind: bug.kind,
    });
  }

  private spawnProjectile(ps: ProjSpawn) {
    const id = nextEntityId++;
    this.projectiles.set(id, {
      id, kind: ps.kind,
      x: ps.x, y: ps.y, z: ps.z,
      vx: ps.vx, vy: ps.vy, vz: ps.vz,
      damage: ps.damage,
      dieAt: Date.now() + PROJECTILE.ttlS * 1000,
    });
  }

  private tickProjectiles(dt: number, now: number) {
    const r2 = (PROJECTILE.radius + PLAYER_RADIUS) ** 2;
    for (const pr of [...this.projectiles.values()]) {
      pr.vy -= PROJECTILE.gravity * dt;
      const nx = pr.x + pr.vx * dt;
      const ny = pr.y + pr.vy * dt;
      const nz = pr.z + pr.vz * dt;

      let hitPlayer: SPlayer | null = null;
      for (const p of this.players.values()) {
        if (!p.alive || p.boarded) continue;
        const dx = p.pos[0] - nx;
        const dy = p.pos[1] + 1.0 - ny;
        const dz = p.pos[2] - nz;
        if (dx * dx + dy * dy + dz * dz <= r2) { hitPlayer = p; break; }
      }
      const groundY = terrainHeight(this.mission.seed, nx, nz);
      const expired = now >= pr.dieAt || Math.abs(nx) > MAP_HALF || Math.abs(nz) > MAP_HALF;

      if (hitPlayer || ny <= groundY || expired) {
        this.projectiles.delete(pr.id);
        this.broadcast({ type: 'splat', pos: [nx, Math.max(ny, groundY), nz], kind: pr.kind });
        if (hitPlayer) this.damagePlayer(hitPlayer, pr.damage);
        continue;
      }
      pr.x = nx;
      pr.y = ny;
      pr.z = nz;
    }
  }

  private tickSentries(now: number) {
    for (const s of [...this.sentries.values()]) {
      if (now >= s.dieAt) {
        this.sentries.delete(s.id);
        continue;
      }
      // acquire the nearest live bug in range
      let target: SBug | null = null;
      let best = SENTRY.range * SENTRY.range;
      for (const bug of this.bugs.values()) {
        const d2 = (bug.x - s.x) ** 2 + (bug.z - s.z) ** 2;
        if (d2 < best) { best = d2; target = bug; }
      }
      if (!target) continue;
      s.yaw = Math.atan2(target.x - s.x, target.z - s.z);
      if (now < s.fireReadyAt) continue;
      s.fireReadyAt = now + SENTRY.fireInterval * 1000;
      const from: Vec3 = [s.x, s.y + 0.9, s.z];
      const to: Vec3 = [target.x, bugY(this.mission.seed, target), target.z];
      this.broadcast({ type: 'sentryFire', id: s.id, from, to });
      target.hp -= SENTRY.damage;
      target.aggro = true;
      if (target.hp <= 0) this.killBug(target, this.players.get(s.owner) ?? null);
    }
  }

  private tickFires(dt: number, now: number) {
    for (const f of [...this.fires.values()]) {
      if (now >= f.dieAt) {
        this.fires.delete(f.id);
        continue;
      }
      const r2 = f.radius * f.radius;
      for (const bug of [...this.bugs.values()]) {
        if ((bug.x - f.x) ** 2 + (bug.z - f.z) ** 2 <= r2) {
          bug.hp -= NAPALM.dps * dt;
          bug.aggro = true;
          if (bug.hp <= 0) this.killBug(bug, null);
        }
      }
      for (const p of this.players.values()) {
        if (!p.alive || p.boarded) continue;
        if ((p.pos[0] - f.x) ** 2 + (p.pos[2] - f.z) ** 2 <= r2) {
          this.damagePlayer(p, NAPALM.dps * dt); // friendly fire: don't stand in the fire
        }
      }
    }
  }

  // ---- networking ----------------------------------------------------------

  private playerState(p: SPlayer): PlayerState {
    return {
      id: p.id,
      name: p.name,
      pos: [p.pos[0], p.pos[1], p.pos[2]],
      yaw: p.yaw,
      pitch: p.pitch,
      anim: (p.anim & ~ANIM.DEAD) | (p.alive ? 0 : ANIM.DEAD) | (Date.now() < p.diveUntil ? ANIM.DIVING : 0),
      hp: Math.round(p.hp),
      ammo: p.ammo,
      reserve: p.reserve,
      kills: p.kills,
      boarded: p.boarded,
    };
  }

  private playerStates(): PlayerState[] {
    return [...this.players.values()].map((p) => this.playerState(p));
  }

  private broadcastSnapshot(now: number) {
    const bugs: BugState[] = [...this.bugs.values()].map((b) => {
      const s: BugState = {
        id: b.id,
        kind: b.kind,
        pos: [b.x, bugY(this.mission.seed, b), b.z],
        yaw: b.yaw,
        hp: Math.round(b.hp),
      };
      if (b.flags) s.flags = b.flags;
      return s;
    });
    const supplies = [...this.supplies.values()].map((s) => ({
      id: s.id,
      pos: s.pos,
      charges: s.charges,
    }));
    const projectiles: ProjectileState[] = [...this.projectiles.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      pos: [p.x, p.y, p.z],
      vel: [p.vx, p.vy, p.vz],
    }));
    const sentries: SentryState[] = [...this.sentries.values()].map((s) => ({
      id: s.id,
      pos: [s.x, s.y, s.z],
      yaw: s.yaw,
      hp: Math.round(s.hp),
    }));
    const fires: FireZoneState[] = [...this.fires.values()].map((f) => ({
      id: f.id,
      pos: [f.x, terrainHeight(this.mission.seed, f.x, f.z), f.z],
      radius: f.radius,
    }));
    const titan = this.titanId ? this.bugs.get(this.titanId) : undefined;
    const boss = titan
      ? { id: titan.id, hp: Math.round(titan.hp), hpMax: BUG_KINDS[titan.kind].hp }
      : null;
    this.broadcast({
      type: 'snapshot',
      t: now,
      players: this.playerStates(),
      bugs,
      supplies,
      mission: this.mission,
      projectiles: projectiles.length ? projectiles : undefined,
      sentries: sentries.length ? sentries : undefined,
      fires: fires.length ? fires : undefined,
      boss,
    });
  }

  private sendTo(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) {
      if (ws !== except && ws.readyState === ws.OPEN) ws.send(raw);
    }
  }
}

function bugY(seed: number, bug: SBug): number {
  return terrainHeight(seed, bug.x, bug.z) + BUG_KINDS[bug.kind].radius * 0.9;
}
