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
