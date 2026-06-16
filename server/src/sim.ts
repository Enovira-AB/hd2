// Server-side simulation: bug AI and hitscan combat. The server owns all
// gameplay outcomes; clients only render what happens here.

import {
  BUG_KINDS,
  BUG_AGGRO_RANGE,
  BUG_SEPARATION,
  CHARGE,
  MAP_HALF,
  PROJECTILE,
  RIFLE,
  TITAN_STOMP,
} from '../../shared/constants.js';
import { terrainHeight, resolveCollisions, raycastRocks, type WorldLayout } from '../../shared/world.js';
import { BUGFLAG, type Vec3, type HitKind } from '../../shared/protocol.js';

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
  diveUntil: number; // server-driven dive in progress until this clock time
  diveReadyAt: number; // cooldown
  diveDx: number;
  diveDz: number;
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
  flags: number; // BUGFLAG bits, surfaced to clients
  windupUntil: number; // charger telegraph end
  chargeUntil: number; // charger lunge end
  chargeDx: number;
  chargeDz: number;
}

export interface BugAttack {
  bug: SBug;
  player: SPlayer;
  damage: number;
  knockback?: number;
}

export interface ProjSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  damage: number;
  kind: number; // 0 acid (spitter), 1 bile (titan)
}

export interface Stomp { x: number; z: number; radius: number; damage: number }

export interface BugTickResult {
  attacks: BugAttack[];
  projectiles: ProjSpawn[];
  stomps: Stomp[];
}

export function bugBodyY(seed: number, bug: SBug): number {
  return terrainHeight(seed, bug.x, bug.z) + BUG_KINDS[bug.kind].radius * 0.9;
}

// Lead the target a little so ranged spit actually connects with movers.
function aimProjectile(
  bug: SBug, target: SPlayer, seed: number, speed: number, kind: number, damage: number,
): ProjSpawn {
  const muzzleY = terrainHeight(seed, bug.x, bug.z) + BUG_KINDS[bug.kind].radius * 1.4;
  const tx = target.pos[0];
  const ty = target.pos[1] + 1.0;
  const tz = target.pos[2];
  const flat = Math.hypot(tx - bug.x, tz - bug.z);
  const tof = flat / speed; // time of flight (flat approximation)
  const aimX = tx;
  const aimZ = tz;
  const dx = aimX - bug.x;
  const dz = aimZ - bug.z;
  const dy = ty - muzzleY;
  const len = Math.hypot(dx, dy, dz) || 1;
  // add the vertical component the glob loses to gravity over the flight
  const vy = (dy / len) * speed + 0.5 * PROJECTILE.gravity * tof;
  return {
    x: bug.x, y: muzzleY, z: bug.z,
    vx: (dx / len) * speed, vy, vz: (dz / len) * speed,
    damage, kind,
  };
}

// Advances all bugs; returns melee attacks, ranged projectile spawns and
// titan stomps for the room to apply.
export function tickBugs(
  bugs: Iterable<SBug>,
  players: SPlayer[],
  seed: number,
  layout: WorldLayout,
  dt: number,
  now: number,
  rng: () => number,
): BugTickResult {
  const attacks: BugAttack[] = [];
  const projectiles: ProjSpawn[] = [];
  const stomps: Stomp[] = [];
  const targets = players.filter((p) => p.alive && !p.boarded);
  const all = Array.from(bugs);

  for (const bug of all) {
    const def = BUG_KINDS[bug.kind];
    bug.flags = 0;

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

      // ---- charger lunge state machine ----
      if (def.charge && now < bug.chargeUntil) {
        bug.flags |= BUGFLAG.CHARGING;
        vx = bug.chargeDx * def.speed * CHARGE.speedMult;
        vz = bug.chargeDz * def.speed * CHARGE.speedMult;
        bug.yaw = Math.atan2(bug.chargeDx, bug.chargeDz);
        if (nearestDist <= def.radius + 1.0 && now >= bug.attackReadyAt) {
          bug.attackReadyAt = now + def.attackCooldown * 1000;
          bug.chargeUntil = now; // lunge connects, stop here
          attacks.push({ bug, player: nearest, damage: def.damage, knockback: CHARGE.knockback });
        }
      } else if (def.charge && now < bug.windupUntil) {
        bug.flags |= BUGFLAG.WINDUP;
        bug.yaw = Math.atan2(dx, dz); // track during telegraph
        if (now + dt * 1000 >= bug.windupUntil) {
          const len = Math.hypot(dx, dz) || 1;
          bug.chargeDx = dx / len;
          bug.chargeDz = dz / len;
          bug.chargeUntil = now + CHARGE.lungeS * 1000;
        }
      } else {
        bug.yaw = Math.atan2(dx, dz);

        if (def.ranged) {
          // hold a preferred distance and lob acid
          const pref = def.preferredRange ?? 0;
          if (pref > 0 && nearestDist < pref - 2) {
            vx = -(dx / nearestDist) * def.speed; // back off
            vz = -(dz / nearestDist) * def.speed;
          } else if (nearestDist > def.attackRange) {
            vx = (dx / nearestDist) * def.speed; // close in to firing range
            vz = (dz / nearestDist) * def.speed;
          }
          if (nearestDist <= def.attackRange && now >= bug.attackReadyAt) {
            bug.attackReadyAt = now + def.attackCooldown * 1000;
            if (def.boss) {
              // titan: spread volley of three globs
              for (let k = -1; k <= 1; k++) {
                const spread = { ...nearest, pos: [nearest.pos[0] + k * 3, nearest.pos[1], nearest.pos[2]] as Vec3 };
                projectiles.push(aimProjectile(bug, spread as SPlayer, seed, PROJECTILE.speed, 1, def.projDamage ?? 20));
              }
            } else {
              projectiles.push(aimProjectile(bug, nearest, seed, PROJECTILE.speed, 0, def.projDamage ?? 18));
            }
          }
        }

        // melee / approach (chargers and melee kinds, and titan stomp)
        if (!def.ranged || def.boss) {
          if (nearestDist > def.attackRange * 0.85) {
            vx = (dx / nearestDist) * def.speed;
            vz = (dz / nearestDist) * def.speed;
          } else if (now >= bug.attackReadyAt) {
            bug.attackReadyAt = now + def.attackCooldown * 1000;
            if (def.boss) {
              stomps.push({ x: bug.x, z: bug.z, radius: TITAN_STOMP.radius, damage: TITAN_STOMP.damage });
            } else {
              attacks.push({ bug, player: nearest, damage: def.damage });
            }
          }
        }

        // charger decides to wind up a lunge from mid-range
        if (def.charge && now >= bug.attackReadyAt &&
            nearestDist > CHARGE.minRange && nearestDist < CHARGE.maxRange) {
          bug.windupUntil = now + CHARGE.windupS * 1000;
          bug.attackReadyAt = now + (CHARGE.windupS + CHARGE.lungeS + 0.6) * 1000;
        }
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

    // crowd separation so swarms read as individuals, not a blob (titans shove)
    const sep = BUG_SEPARATION * (def.boss ? 2.6 : def.radius > 1 ? 1.6 : 1);
    for (const other of all) {
      if (other === bug) continue;
      const dx = bug.x - other.x;
      const dz = bug.z - other.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < sep * sep && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = def.boss ? 2 : 6;
        vx += (dx / d) * ((sep - d) / sep) * push;
        vz += (dz / d) * ((sep - d) / sep) * push;
      }
    }

    bug.x += vx * dt;
    bug.z += vz * dt;
    [bug.x, bug.z] = resolveCollisions(bug.x, bug.z, def.radius * 0.8, layout.rocks);
    const lim = MAP_HALF - 2;
    bug.x = Math.max(-lim, Math.min(lim, bug.x));
    bug.z = Math.max(-lim, Math.min(lim, bug.z));
  }
  return { attacks, projectiles, stomps };
}

export interface HitscanResult {
  dist: number;
  point: Vec3;
  kind: HitKind;
  bug?: SBug;
  player?: SPlayer;
  nestIndex?: number;
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
  nestHp?: number[],
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

  if (nestHp) {
    for (let i = 0; i < layout.nests.length; i++) {
      if (nestHp[i] <= 0) continue;
      const n = layout.nests[i];
      const t = raySphere(origin, dir, n.x, terrainHeight(seed, n.x, n.z) + 1.0, n.z, 2.7);
      if (t < best.dist) best = { dist: t, point: pointAt(origin, dir, t), kind: 'nest', nestIndex: i };
    }
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
