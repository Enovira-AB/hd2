// Verifies difficulty tiers: the host can only select tiers their rank has
// unlocked, and the chosen tier actually scales the mission (kill quota and
// enemy HP). Uses an isolated, pre-seeded account so the gate is deterministic.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8148;
const PID = 'testpid-diff-0001';
const SEED_XP = 300; // -> rank 3 (HARD unlocked at 3; EXTREME locked at 5)
const KILL_BASE = 10;
const BASE_HP = [30, 130, 70, 360, 3200]; // BUG_KINDS hp, mirror of shared/constants
const HARD = { id: 3, hpMult: 1.25, killMult: 1.3 };
const OVERRIDES = { killBase: KILL_BASE, killPerExtraPlayer: 0, bugCapBase: 6, spawnIntervalS: 0.3, dropDurationS: 0.5, resetDelayS: 1 };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-diff-'));
fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify([
  { pid: PID, name: 'Cmd', xp: SEED_XP, kills: 0, missions: 0, created: Date.now(), updated: Date.now() },
]));

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_OBJECTIVE: 'ERADICATE', HD_DATA_DIR: dataDir, HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 40s timeout'), 40_000);
function fail(why) { console.error(`\nDIFFICULTY TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let mission = null; // latest mission state (from welcome/phase/snapshot)
let self = '';

let ws;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {}
    await sleep(200);
    if (i === 49) fail('server never healthy');
  }
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('error', (e) => fail(`ws error: ${e.message}`));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'welcome') { self = m.self; mission = m.mission; }
    if (m.type === 'phase') mission = m.mission;
    if (m.type === 'snapshot') { snapshot = m; mission = m.mission; }
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Cmd', pid: PID }));

  // 1) default tier is CHALLENGING (2)
  for (let i = 0; i < 40 && !mission; i++) await sleep(80);
  if (!mission) fail('no mission state');
  if (mission.difficulty !== 2) fail(`default difficulty is ${mission.difficulty}, expected 2`);
  ok('default difficulty is CHALLENGING (2)');

  // 2) a tier above our rank (EXTREME, unlock 5) is rejected
  ws.send(JSON.stringify({ type: 'difficulty', tier: 4 }));
  await sleep(600);
  if (mission.difficulty !== 2) fail(`locked tier 4 was accepted (difficulty=${mission.difficulty})`);
  ok('locked tier (EXTREME, needs rank 5) rejected at rank 3');

  // 3) an unlocked tier (HARD, unlock 3) is accepted
  ws.send(JSON.stringify({ type: 'difficulty', tier: HARD.id }));
  for (let i = 0; i < 40 && mission.difficulty !== HARD.id; i++) await sleep(80);
  if (mission.difficulty !== HARD.id) fail(`HARD not accepted (difficulty=${mission.difficulty})`);
  ok('unlocked tier (HARD) selected');

  // 4) starting applies the tier: kill quota scales by killMult
  ws.send(JSON.stringify({ type: 'start' }));
  for (let i = 0; i < 60; i++) { if (mission?.phase === 'KILL') break; await sleep(80); }
  if (mission.phase !== 'KILL') fail('never reached KILL phase');
  const expectedTarget = Math.max(1, Math.round(KILL_BASE * HARD.killMult));
  if (mission.killTarget !== expectedTarget) fail(`killTarget ${mission.killTarget}, expected ${expectedTarget} (×${HARD.killMult})`);
  ok(`kill quota scaled: ${KILL_BASE} → ${mission.killTarget} (×${HARD.killMult})`);

  // 5) spawned enemies have HP scaled by hpMult (bot never fires, so HP is full)
  let scaled = null;
  for (let i = 0; i < 80 && !scaled; i++) {
    for (const b of snapshot?.bugs ?? []) {
      const expected = Math.round(BASE_HP[b.kind] * HARD.hpMult);
      if (b.hp === expected && b.hp !== BASE_HP[b.kind]) { scaled = { b, expected }; break; }
    }
    if (!scaled) await sleep(100);
  }
  if (!scaled) fail('no enemy showed HP scaled by the difficulty hpMult');
  ok(`enemy HP scaled: kind ${scaled.b.kind} at ${scaled.b.hp} hp (base ${BASE_HP[scaled.b.kind]} ×${HARD.hpMult})`);

  console.log('\nDIFFICULTY TEST PASS — tier gating and mission scaling verified.');
  clearTimeout(deadline);
  killServer();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
