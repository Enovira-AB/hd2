// Deterministic world generation, shared verbatim by server and web client and
// ported to Swift (ios/Sources/WorldGen.swift). Everything is derived from the
// mission seed with 32-bit integer math so every platform computes the exact
// same terrain, rocks and nest layout. Do not introduce floating point into
// the hashing path.

import { MAP_HALF } from './constants.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(seed: number, ix: number, iz: number): number {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smoothstep(x - ix);
  const fz = smoothstep(z - iz);
  const a = hash2(seed, ix, iz);
  const b = hash2(seed, ix + 1, iz);
  const c = hash2(seed, ix, iz + 1);
  const d = hash2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

// Smoothly flattens terrain inside radius r around (cx, cz); returns 0..1.
function flatten(x: number, z: number, cx: number, cz: number, r: number): number {
  const d = Math.hypot(x - cx, z - cz);
  if (d >= r + 16) return 1;
  if (d <= r) return 0;
  return smoothstep((d - r) / 16);
}

export interface RockDef { x: number; z: number; r: number; h: number }
export interface NestDef { x: number; z: number }
export interface WorldLayout {
  pad: { x: number; z: number };
  rocks: RockDef[];
  nests: NestDef[];
}

export function padPosition(seed: number): { x: number; z: number } {
  const rng = mulberry32(seed ^ 0x5add);
  const ang = rng() * Math.PI * 2;
  const dist = 62 + rng() * 18;
  return { x: Math.cos(ang) * dist, z: Math.sin(ang) * dist };
}

export function terrainHeight(seed: number, x: number, z: number): number {
  let h = valueNoise(seed, x * 0.02 + 100, z * 0.02 + 100) * 5.0;
  h += valueNoise(seed ^ 0x9e37, x * 0.055 + 100, z * 0.055 + 100) * 1.4;
  h += valueNoise(seed ^ 0x51ab, x * 0.16 + 100, z * 0.16 + 100) * 0.35;
  const pad = padPosition(seed);
  h *= flatten(x, z, 0, 0, 9); // squad spawn
  h *= flatten(x, z, pad.x, pad.z, 10); // extraction pad
  return h;
}

export function generateLayout(seed: number): WorldLayout {
  const pad = padPosition(seed);
  const rng = mulberry32(seed ^ 0x70c5);
  const rocks: RockDef[] = [];
  for (let i = 0; i < 140 && rocks.length < 95; i++) {
    const x = (rng() * 2 - 1) * (MAP_HALF - 6);
    const z = (rng() * 2 - 1) * (MAP_HALF - 6);
    const r = 1.1 + rng() * 2.6;
    if (Math.hypot(x, z) < 14 + r) continue;
    if (Math.hypot(x - pad.x, z - pad.z) < 13 + r) continue;
    rocks.push({ x, z, r, h: r * (1.0 + rng() * 0.9) });
  }
  const nests: NestDef[] = [];
  for (let i = 0; i < 40 && nests.length < 5; i++) {
    const ang = rng() * Math.PI * 2;
    const dist = 52 + rng() * 42;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (Math.abs(x) > MAP_HALF - 8 || Math.abs(z) > MAP_HALF - 8) continue;
    if (Math.hypot(x - pad.x, z - pad.z) < 30) continue;
    if (nests.some((n) => Math.hypot(n.x - x, n.z - z) < 34)) continue;
    nests.push({ x, z });
  }
  return { pad, rocks, nests };
}

// Push a circle of given radius out of rocks and map bounds. Returns new x/z.
export function resolveCollisions(
  x: number,
  z: number,
  radius: number,
  rocks: RockDef[],
): [number, number] {
  const lim = MAP_HALF - radius;
  let nx = Math.max(-lim, Math.min(lim, x));
  let nz = Math.max(-lim, Math.min(lim, z));
  for (const rock of rocks) {
    const dx = nx - rock.x;
    const dz = nz - rock.z;
    const min = rock.r * 0.82 + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      nx = rock.x + (dx / d) * min;
      nz = rock.z + (dz / d) * min;
    }
  }
  return [nx, nz];
}

// 2D ray vs rock circles with a height gate, used for hitscan occlusion.
// Returns distance along the ray or Infinity.
export function raycastRocks(
  seed: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  rocks: RockDef[],
): number {
  let best = Infinity;
  const len2d = Math.hypot(dx, dz);
  if (len2d < 1e-6) return best;
  for (const rock of rocks) {
    const rx = rock.x - ox;
    const rz = rock.z - oz;
    const t = (rx * dx + rz * dz) / (len2d * len2d);
    if (t < 0 || t * len2d > maxDist) continue;
    const cx = ox + dx * t - rock.x;
    const cz = oz + dz * t - rock.z;
    const rr = rock.r * 0.82;
    if (cx * cx + cz * cz > rr * rr) continue;
    const hitY = oy + dy * t;
    const top = terrainHeight(seed, rock.x, rock.z) + rock.h;
    if (hitY <= top && t * Math.hypot(dx, dy, dz) < best) {
      best = t * Math.hypot(dx, dy, dz);
    }
  }
  return best;
}
