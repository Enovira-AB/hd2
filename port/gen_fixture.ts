// Dumps a golden fixture from the TypeScript source of truth so any native
// port (C#/Unity, C++/Unreal) can prove it reproduces the exact same world and
// RNG sequence. The integer RNG path must match EXACTLY; float-derived
// positions match within a tiny epsilon (cos/sin can differ by a ULB across
// math libraries — see port/README.md).
//
// Run: npx tsx port/gen_fixture.ts   → writes port/worldgen_fixture.json

import { writeFileSync } from 'node:fs';
import { mulberry32, padPosition, terrainHeight, generateLayout } from '../shared/world.js';

// default JS number formatting round-trips a double exactly through any
// correctly-rounded parser (V8 ⇄ glibc strtod), so the .txt is bit-faithful
const num = (v: number) => String(v);

const SEEDS = [1, 1337, 0xbeef, 0xdeadbeef >>> 0, 2024, 7777777];

// raw mulberry32 stream for a couple of seeds (exact-match check of the RNG)
function rngStream(seed: number, n: number): number[] {
  const rng = mulberry32(seed >>> 0);
  return Array.from({ length: n }, () => rng());
}

// a fixed grid of terrainHeight probes (epsilon-match check of the noise field)
function heightGrid(seed: number): { x: number; z: number; h: number }[] {
  const out: { x: number; z: number; h: number }[] = [];
  for (let x = -90; x <= 90; x += 30) {
    for (let z = -90; z <= 90; z += 30) {
      out.push({ x, z, h: terrainHeight(seed, x, z) });
    }
  }
  return out;
}

const fixture = {
  _note: 'Golden outputs from shared/world.ts. rng = exact match; pad/height/layout = match within 1e-6.',
  rng: { seed: 1337, values: rngStream(1337, 24) },
  worlds: SEEDS.map((seed) => ({
    seed,
    pad: padPosition(seed),
    heights: heightGrid(seed),
    layout: generateLayout(seed),
  })),
};

writeFileSync('port/worldgen_fixture.json', JSON.stringify(fixture, null, 2));

// flat text twin for the C++ verifier (no JSON lib needed, parses with >>)
const lines: string[] = [];
lines.push(`RNG ${fixture.rng.seed >>> 0} ${fixture.rng.values.length}`);
for (const v of fixture.rng.values) lines.push(num(v));
for (const w of fixture.worlds) {
  lines.push(`WORLD ${w.seed >>> 0}`);
  lines.push(`PAD ${num(w.pad.x)} ${num(w.pad.z)}`);
  lines.push(`HEIGHTS ${w.heights.length}`);
  for (const p of w.heights) lines.push(`${num(p.x)} ${num(p.z)} ${num(p.h)}`);
  lines.push(`ROCKS ${w.layout.rocks.length}`);
  for (const r of w.layout.rocks) lines.push(`${num(r.x)} ${num(r.z)} ${num(r.r)} ${num(r.h)}`);
  lines.push(`NESTS ${w.layout.nests.length}`);
  for (const n of w.layout.nests) lines.push(`${num(n.x)} ${num(n.z)}`);
}
writeFileSync('port/worldgen_fixture.txt', lines.join('\n') + '\n');

console.log(`wrote port/worldgen_fixture.{json,txt} — ${SEEDS.length} worlds, rng stream of ${fixture.rng.values.length}`);
for (const w of fixture.worlds) {
  console.log(`  seed ${w.seed >>> 0}: ${w.layout.rocks.length} rocks, ${w.layout.nests.length} nests, pad (${w.pad.x.toFixed(1)}, ${w.pad.z.toFixed(1)})`);
}
