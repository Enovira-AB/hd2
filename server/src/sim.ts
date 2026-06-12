// Server-side simulation: bug AI and hitscan combat. The server owns all
// gameplay outcomes; clients only render what happens here.

import {
  BUG_KINDS,
  BUG_AGGRO_RANGE,
  BUG_SEPARATION,
  MAP_HALF,
  RIFLE,
} from '../../shared/constants.js';
import { terrainHeight, resolveCollisions, raycastRocks, type WorldLayout } from '../../shared/world.js';
import type { Vec3, HitKind } from '../../shared/protocol.js';

export interface SPlayer {
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
  alive: boolean;
  boarded: boolean;
  lastFireAt: number;
  reloadEndAt: number;
  pendingReload: boolean;
  lastDamageAt: number;
  lastStateAt: number;
}

export interface SBug {
  id: number;
  kind: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  aggro: boolean;
  nest: number;
  targetX: number;
  targetZ: number;
  wanderUntil: number;
  attackReadyAt: number;
}

export interface BugAttack {
  bug: SBug;
  player: SPlayer;
  damage: number;
}

export function bugBodyY(seed: number, bug: SBug): number {
  return terrainHeight(seed, bug.x, bug.z) + BUG_KINDS[bug.kind].radius * 0.9;
}

// Advances all bugs; returns melee attacks for the room to apply.
export function tickBugs(
  bugs: Iterable<SBug>,
  players: SPlayer[],
  seed: number,
  layout: WorldLayout,
  dt: number,
  now: number,
  rng: () => number,
): BugAttack[] {
  const attacks: BugAttack[] = [];
  const targets = players.filter((p) => p.alive && !p.boarded);
  const all = Array.from(bugs);

  for (const bug of all) {
    const def = BUG_KINDS[bug.kind];

    let nearest: SPlayer | null = null;
    let nearestDist = Infinity;
    for (const p of targets) {
      const d = Math.hypot(p.pos[0] - bug.x, p.pos[2] - bug.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p;
      }
    }
    if (nearest && nearestDist < BUG_AGGRO_RANGE) bug.aggro = true;
    if (!nearest) bug.aggro = false;

    let vx = 0;
    let vz = 0;
    if (bug.aggro && nearest) {
      const dx = nearest.pos[0] - bug.x;
      const dz = nearest.pos[2] - bug.z;
      bug.yaw = Math.atan2(dx, dz);
      if (nearestDist > def.attackRange * 0.85) {
        vx = (dx / nearestDist) * def.speed;
        vz = (dz / nearestDist) * def.speed;
      } else if (now >= bug.attackReadyAt) {
        bug.attackReadyAt = now + def.attackCooldown * 1000;
        attacks.push({ bug, player: nearest, damage: def.damage });
      }
    } else {
      if (now > bug.wanderUntil) {
        const nest = layout.nests[bug.nest] ?? { x: 0, z: 0 };
        bug.targetX = nest.x + (rng() * 2 - 1) * 18;
        bug.targetZ = nest.z + (rng() * 2 - 1) * 18;
        bug.wanderUntil = now + 2500 + rng() * 4500;
      }
      const dx = bug.targetX - bug.x;
      const dz = bug.targetZ - bug.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.2) {
        vx = (dx / d) * def.speed * 0.35;
        vz = (dz / d) * def.speed * 0.35;
        bug.yaw = Math.atan2(dx, dz);
      }
    }

    // crowd separation so swarms read as individuals, not a blob
    for (const other of all) {
      if (other === bug) continue;
      const dx = bug.x - other.x;
      const dz = bug.z - other.z;
      const d2 = dx * dx + dz * dz;
      const min = BUG_SEPARATION;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        vx += (dx / d) * ((min - d) / min) * 6;
        vz += (dz / d) * ((min - d) / min) * 6;
      }
    }

    bug.x += vx * dt;
    bug.z += vz * dt;
    [bug.x, bug.z] = resolveCollisions(bug.x, bug.z, def.radius * 0.8, layout.rocks);
    const lim = MAP_HALF - 2;
    bug.x = Math.max(-lim, Math.min(lim, bug.x));
    bug.z = Math.max(-lim, Math.min(lim, bug.z));
  }
  return attacks;
}

export interface HitscanResult {
  dist: number;
  point: Vec3;
  kind: HitKind;
  bug?: SBug;
  player?: SPlayer;
}

function raySphere(
  origin: Vec3,
  dir: Vec3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number {
  const ox = origin[0] - cx;
  const oy = origin[1] - cy;
  const oz = origin[2] - cz;
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

export function hitscan(
  shooter: SPlayer,
  origin: Vec3,
  dir: Vec3,
  seed: number,
  layout: WorldLayout,
  bugs: Iterable<SBug>,
  players: Iterable<SPlayer>,
): HitscanResult {
  let best: HitscanResult = { dist: RIFLE.range, point: pointAt(origin, dir, RIFLE.range), kind: 'none' };

  const rockDist = raycastRocks(
    seed, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], RIFLE.range, layout.rocks,
  );
  if (rockDist < best.dist) {
    best = { dist: rockDist, point: pointAt(origin, dir, rockDist), kind: 'rock' };
  }

  for (const bug of bugs) {
    const t = raySphere(origin, dir, bug.x, bugBodyY(seed, bug), bug.z, BUG_KINDS[bug.kind].radius * 1.15);
    if (t < best.dist) best = { dist: t, point: pointAt(origin, dir, t), kind: 'bug', bug };
  }

  for (const p of players) {
    if (p === shooter || !p.alive || p.boarded) continue;
    const t = raySphere(origin, dir, p.pos[0], p.pos[1] + 1.1, p.pos[2], 0.55);
    if (t < best.dist) best = { dist: t, point: pointAt(origin, dir, t), kind: 'player', player: p };
  }

  // coarse terrain march so misses still kick up dust where the round lands
  if (best.kind === 'none' && dir[1] < 0.15) {
    for (let t = 6; t < RIFLE.range; t += 3) {
      const x = origin[0] + dir[0] * t;
      const y = origin[1] + dir[1] * t;
      const z = origin[2] + dir[2] * t;
      if (Math.abs(x) > MAP_HALF || Math.abs(z) > MAP_HALF) break;
      if (y <= terrainHeight(seed, x, z)) {
        best = { dist: t, point: [x, y, z], kind: 'rock' };
        break;
      }
    }
  }
  return best;
}

function pointAt(origin: Vec3, dir: Vec3, t: number): Vec3 {
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}
