// Validates that every animation clip in the model manifest actually binds to
// its target mesh's skeleton. three.js binds AnimationClip tracks to bones by
// NAME, so a clip whose channels target bones the mesh doesn't have will simply
// not animate. We parse each GLB's JSON chunk (no browser needed) and check that
// the nodes an animation drives exist in the mesh it's attached to.
//
// Run: node scripts/check-bones.mjs   (exits non-zero if a pairing is broken)

import fs from 'node:fs';
import path from 'node:path';

const MODELS_DIR = 'web/public/models';
const MIN_COVERAGE = 0.6; // a real rig match shares well over 60% of bone names

// Read the JSON chunk out of a .glb (12-byte header, then length-prefixed chunks)
function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) return JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8')); // 'JSON'
    off += 8 + len;
  }
  throw new Error(`${file}: no JSON chunk`);
}

const nodeNames = (gltf) => new Set((gltf.nodes ?? []).map((n) => n.name).filter(Boolean));

// node names an animation actually drives (channel targets)
function animTargets(gltf) {
  const names = new Set();
  for (const anim of gltf.animations ?? []) {
    for (const ch of anim.channels ?? []) {
      const n = gltf.nodes?.[ch.target?.node]?.name;
      if (n) names.add(n);
    }
  }
  return names;
}

const manifest = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'manifest.json'), 'utf8'));
let failures = 0;
let checked = 0;

for (const [key, entry] of Object.entries(manifest)) {
  if (key.startsWith('_') || !entry || typeof entry !== 'object' || !entry.file) continue;
  let bones;
  try {
    bones = nodeNames(readGlbJson(path.join(MODELS_DIR, entry.file)));
  } catch (e) {
    console.error(`✗ ${key}: ${e.message}`);
    failures++;
    continue;
  }
  for (const [animKey, animFile] of Object.entries(entry.anims ?? {})) {
    checked++;
    let targets;
    try {
      targets = animTargets(readGlbJson(path.join(MODELS_DIR, animFile)));
    } catch (e) {
      console.error(`✗ ${key}.${animKey} (${animFile}): ${e.message}`);
      failures++;
      continue;
    }
    if (targets.size === 0) {
      console.error(`✗ ${key}.${animKey} (${animFile}): no animation channels`);
      failures++;
      continue;
    }
    const matched = [...targets].filter((n) => bones.has(n)).length;
    const coverage = matched / targets.size;
    const flag = coverage >= MIN_COVERAGE ? 'ok ' : '✗  ';
    console.log(`  ${flag}${key} (${entry.file}) ← ${animKey}: ${matched}/${targets.size} bones (${(coverage * 100).toFixed(0)}%)`);
    if (coverage < MIN_COVERAGE) failures++;
  }
}

console.log(`\n${checked} pairings checked, ${failures} broken`);
if (failures) { console.error('BONE CHECK FAIL — an animation will not bind to its mesh'); process.exit(1); }
console.log('BONE CHECK PASS — every clip binds to its skeleton');
