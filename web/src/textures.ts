// Procedurally generated textures (DataTexture — pure math, no DOM, so the
// Node preview renderer can still import model files). Cached singletons.

import * as THREE from 'three';
import { mulberry32 } from '../../shared/world.js';

function makeTexture(size: number, fill: (x: number, y: number) => [number, number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let soft: THREE.DataTexture | null = null;
// soft round particle: smooth radial falloff, for Points and small sprites
export function softCircleTexture(): THREE.DataTexture {
  if (soft) return soft;
  const size = 64;
  soft = makeTexture(size, (x, y) => {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
    const v = Math.pow(Math.max(0, 1 - d), 1.8) * 255;
    return [v, v, v, v];
  });
  return soft;
}

let glow: THREE.DataTexture | null = null;
// light glow: hot core with a wide soft halo, for additive sprites on lights
export function glowTexture(): THREE.DataTexture {
  if (glow) return glow;
  const size = 128;
  glow = makeTexture(size, (x, y) => {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
    const core = Math.pow(Math.max(0, 1 - d * 2.4), 2) * 1.0;
    const halo = Math.pow(Math.max(0, 1 - d), 2.6) * 0.55;
    const v = Math.min(1, core + halo) * 255;
    return [v, v, v, v];
  });
  return glow;
}

let smoke: THREE.DataTexture | null = null;
// blotchy smoke puff: radial falloff broken up by darker sub-circles
export function smokeTexture(): THREE.DataTexture {
  if (smoke) return smoke;
  const size = 96;
  const rng = mulberry32(4242);
  const blots: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 7; i++) {
    blots.push({
      x: (rng() - 0.5) * size * 0.7 + size / 2,
      y: (rng() - 0.5) * size * 0.7 + size / 2,
      r: size * (0.12 + rng() * 0.16),
    });
  }
  smoke = makeTexture(size, (x, y) => {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
    let v = Math.pow(Math.max(0, 1 - d), 1.5);
    for (const b of blots) {
      const bd = Math.hypot(x - b.x, y - b.y) / b.r;
      if (bd < 1) v *= 0.55 + 0.45 * bd;
    }
    const a = v * 255;
    return [255, 255, 255, a];
  });
  return smoke;
}

let speckle: THREE.DataTexture | null = null;
// subtle grayscale grain multiplied over the terrain's vertex colors
export function terrainSpeckleTexture(): THREE.DataTexture {
  if (speckle) return speckle;
  const size = 128;
  const rng = mulberry32(1717);
  const vals = new Float32Array(size * size);
  for (let i = 0; i < vals.length; i++) vals[i] = rng();
  speckle = makeTexture(size, (x, y) => {
    // two octaves of pseudo-noise for visible but soft surface grain
    const i = y * size + x;
    const j = ((y >> 2) * size + (x >> 2) * 5) % vals.length;
    const v = 215 + (vals[i] * 0.5 + vals[Math.abs(j)] * 0.5) * 40;
    return [v, v, v, 255];
  });
  speckle.wrapS = THREE.RepeatWrapping;
  speckle.wrapT = THREE.RepeatWrapping;
  speckle.colorSpace = THREE.SRGBColorSpace;
  return speckle;
}

// convenience: additive glow sprite for attaching to light sources
export function makeGlowSprite(color: number, scale: number, opacity = 0.6): THREE.Sprite {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(),
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  sprite.scale.set(scale, scale, 1);
  return sprite;
}

// ---- painted material maps (albedo + normal) --------------------------------------

// tiling value-noise field used by the painters below
function noiseField(size: number, seed: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  const rng = mulberry32(seed);
  let amp = 1;
  let cell = size / 4;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const grid = Math.max(2, Math.round(size / cell));
    const lattice = new Float32Array(grid * grid);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * grid;
        const gy = (y / size) * grid;
        const x0 = Math.floor(gx) % grid;
        const y0 = Math.floor(gy) % grid;
        const x1 = (x0 + 1) % grid;
        const y1 = (y0 + 1) % grid;
        const fx = gx - Math.floor(gx);
        const fy = gy - Math.floor(gy);
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const a = lattice[y0 * grid + x0];
        const b = lattice[y0 * grid + x1];
        const c = lattice[y1 * grid + x0];
        const d = lattice[y1 * grid + x1];
        out[y * size + x] += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
    cell /= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// tangent-space normal map from a height field (wrapping differences = tiles)
function heightToNormal(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  return makeTexture(size, (x, y) => {
    const l = height[y * size + ((x - 1 + size) % size)];
    const r = height[y * size + ((x + 1) % size)];
    const u = height[((y - 1 + size) % size) * size + x];
    const d = height[((y + 1) % size) * size + x];
    const nx = (l - r) * strength;
    const ny = (d - u) * strength;
    const inv = 1 / Math.hypot(nx, ny, 1);
    return [(nx * inv * 0.5 + 0.5) * 255, (ny * inv * 0.5 + 0.5) * 255, (inv * 0.5 + 0.5) * 255, 255];
  });
}

export interface MaterialMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
}

let armor: MaterialMaps | null = null;
// brushed armor plate: panel grooves, rivets, scratches over subtle grain
export function armorMaps(): MaterialMaps {
  if (armor) return armor;
  const size = 256;
  const rng = mulberry32(9001);
  const grain = noiseField(size, 9002, 4);
  const height = new Float32Array(size * size);
  const albedo = new Float32Array(size * size).fill(0.86);

  const grooves: { pos: number; vertical: boolean }[] = [];
  for (let i = 0; i < 3; i++) {
    grooves.push({ pos: Math.floor((0.15 + rng() * 0.7) * size), vertical: true });
    grooves.push({ pos: Math.floor((0.15 + rng() * 0.7) * size), vertical: false });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      height[i] = grain[i] * 0.25;
      albedo[i] += (grain[i] - 0.5) * 0.10;
      for (const g of grooves) {
        const dist = Math.abs((g.vertical ? x : y) - g.pos);
        if (dist < 2.5) {
          height[i] -= (1 - dist / 2.5) * 0.8;
          albedo[i] -= (1 - dist / 2.5) * 0.18;
        }
      }
    }
  }
  // rivets along the grooves
  for (const g of grooves) {
    for (let k = 0; k < 5; k++) {
      const along = Math.floor(rng() * size);
      const cx = g.vertical ? g.pos + 5 : along;
      const cy = g.vertical ? along : g.pos + 5;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > 3) continue;
          const i = (((cy + dy) % size + size) % size) * size + (((cx + dx) % size + size) % size);
          height[i] += (1 - d / 3) * 0.9;
          albedo[i] += (1 - d / 3) * 0.06;
        }
      }
    }
  }
  // scratches: short bright shallow streaks
  for (let s = 0; s < 26; s++) {
    let x = rng() * size;
    let y = rng() * size;
    const ang = rng() * Math.PI * 2;
    const len = 8 + rng() * 30;
    for (let t = 0; t < len; t++) {
      x += Math.cos(ang);
      y += Math.sin(ang);
      const i = ((Math.floor(y) % size + size) % size) * size + ((Math.floor(x) % size + size) % size);
      albedo[i] = Math.min(1.1, albedo[i] + 0.16);
      height[i] -= 0.12;
    }
  }
  const map = makeTexture(size, (x, y) => {
    const v = Math.max(0, Math.min(1.1, albedo[y * size + x])) * 232;
    return [v, v, v, 255];
  });
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  armor = { map, normalMap: heightToNormal(height, size, 2.2) };
  return armor;
}

let chitin: MaterialMaps | null = null;
// insect carapace: ridged segment bands warped by noise, pores
export function chitinMaps(): MaterialMaps {
  if (chitin) return chitin;
  const size = 256;
  const warp = noiseField(size, 5150, 3);
  const pores = noiseField(size, 5151, 5);
  const height = new Float32Array(size * size);
  const map = makeTexture(size, (x, y) => {
    const i = y * size + x;
    const band = Math.pow(Math.max(0, Math.sin((y / size + warp[i] * 0.22) * Math.PI * 7)), 1.6);
    const pore = pores[i] < 0.32 ? (0.32 - pores[i]) * 1.4 : 0;
    height[i] = band * 0.9 - pore * 0.8 + warp[i] * 0.15;
    let v = 0.78 - band * 0.30 - pore * 0.35 + (warp[i] - 0.5) * 0.12;
    v = Math.max(0.2, Math.min(1, v)) * 255;
    return [v, v * 0.94, v * 0.86, 255]; // faint warm tint
  });
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  chitin = { map, normalMap: heightToNormal(height, size, 2.6) };
  return chitin;
}

let rock: MaterialMaps | null = null;
// weathered rock: fractal noise + crack lines
export function rockMaps(): MaterialMaps {
  if (rock) return rock;
  const size = 256;
  const base = noiseField(size, 7700, 5);
  const height = Float32Array.from(base);
  const rng = mulberry32(7701);
  for (let c = 0; c < 9; c++) {
    let x = rng() * size;
    let y = rng() * size;
    let ang = rng() * Math.PI * 2;
    for (let t = 0; t < 90; t++) {
      x += Math.cos(ang);
      y += Math.sin(ang);
      ang += (rng() - 0.5) * 0.5;
      const i = ((Math.floor(y) % size + size) % size) * size + ((Math.floor(x) % size + size) % size);
      height[i] -= 0.9;
    }
  }
  const map = makeTexture(size, (x, y) => {
    const i = y * size + x;
    const v = (0.62 + (base[i] - 0.5) * 0.5 + (height[i] - base[i]) * 0.25) * 235;
    return [Math.max(30, v), Math.max(30, v) * 1.02, Math.max(30, v) * 1.08, 255];
  });
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  rock = { map, normalMap: heightToNormal(height, size, 2.0) };
  return rock;
}

const capes = new Map<number, THREE.DataTexture>();
// team cape: woven fabric, triple chevron emblem, worn lower edge
export function capeTexture(colorHex: number): THREE.DataTexture {
  const cached = capes.get(colorHex);
  if (cached) return cached;
  const size = 128;
  // Color(hex) converts to linear working space; we write raw sRGB bytes
  const color = new THREE.Color(colorHex).convertLinearToSRGB();
  const wear = noiseField(size, 1234, 4);
  const tex = makeTexture(size, (x, y) => {
    const i = y * size + x;
    const weave = ((x % 3 === 0 ? 1 : 0) ^ (y % 3 === 0 ? 1 : 0)) ? 0.94 : 1.0;
    let r = color.r * weave;
    let g = color.g * weave;
    let b = color.b * weave;
    // triple chevron emblem, tips diving down, upper middle of the cape
    // (plane UVs: v=0 is the bottom hem, v=1 the shoulder edge)
    const u = x / size;
    const v = y / size;
    const du = Math.abs(u - 0.5);
    if (du < 0.3) {
      for (let c = 0; c < 3; c++) {
        const tipV = 0.5 + c * 0.13;
        const lineV = tipV + du * 0.55; // center tip is the lowest point
        if (Math.abs(v - lineV) < 0.035) {
          r = 0.85; g = 0.66; b = 0.20;
        }
      }
    }
    // worn, darkened lower hem
    const fray = v < 0.22 ? (0.22 - v) * (2.2 + wear[i] * 2.5) : 0;
    const k = Math.max(0.25, 1 - fray);
    return [r * k * 255, g * k * 255, b * k * 255, 255];
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  capes.set(colorHex, tex);
  return tex;
}
