// Verifies loadouts: the chosen weapon applies (ammo/stats), it kills, and the
// stratagem loadout gates what you can call (brought vs not brought).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8146;
const PID = 'testpid-loadout-0001';
const OVERRIDES = { killBase: 300, killPerExtraPlayer: 0, bugCapBase: 6, spawnIntervalS: 0.3, dropDurationS: 0.5, resetDelayS: 1 };

// seed a maxed account so every weapon (incl. the lvl-3 shotgun) is unlocked
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-loadout-'));
fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify([
  { pid: PID, name: 'Gunner', xp: 5000, kills: 0, missions: 0, created: Date.now(), updated: Date.now() },
]));

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_OBJECTIVE: 'ERADICATE', HD_DATA_DIR: dataDir, HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 40s timeout'), 40_000);
function fail(why) { console.error(`\nLOADOUT TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let self = '';
let kill = false;
let napalmZone = false;
let orbitalBoom = false;

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
    if (m.type === 'welcome') {
      self = m.self;
      // pick a shotgun and bring ORBITAL only (no NAPALM/SENTRY) — before start
      ws.send(JSON.stringify({ type: 'loadout', weapon: 'shotgun', stratagems: ['ORBITAL'] }));
      ws.send(JSON.stringify({ type: 'start' }));
    }
    if (m.type === 'snapshot') {
      snapshot = m;
      if (m.fires && m.fires.length) napalmZone = true;
    }
    if (m.type === 'bugDeath' && m.by === self) kill = true;
    if (m.type === 'boom' && m.kind === 'ORBITAL') orbitalBoom = true;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Gunner', pid: PID }));

  const me = () => snapshot?.players.find((p) => p.id === self);

  // wait for KILL phase, confirm the shotgun is equipped with its 8-round mag
  for (let i = 0; i < 60; i++) { if (snapshot?.mission?.phase === 'KILL') break; await sleep(80); }
  const m0 = me();
  if (!m0) fail('no self in snapshot');
  if (m0.weapon !== 'shotgun') fail(`weapon is ${m0.weapon}, expected shotgun`);
  if (m0.ammo !== 8) fail(`shotgun mag is ${m0.ammo}, expected 8`);
  ok(`shotgun equipped (mag ${m0.ammo})`);

  // Kite-and-blast: back away from the nearest bug so it trails at shotgun
  // range, fire point-blank (the cone connects up close), dive when it closes.
  // Restart if the bot dies so a bad spawn can't end the run.
  const t0 = Date.now();
  let lastStart = 0;
  while (Date.now() - t0 < 25000 && !kill) {
    const phase = snapshot?.mission?.phase;
    if ((phase === 'LOBBY' || phase === 'FAILED' || phase === 'COMPLETE') && Date.now() - lastStart > 1500) {
      ws.send(JSON.stringify({ type: 'start' })); lastStart = Date.now();
    }
    const mm = me();
    if (mm && phase === 'KILL') {
      if (mm.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
      let b = null, bd = Infinity;
      for (const x of snapshot.bugs) { const d = Math.hypot(x.pos[0] - mm.pos[0], x.pos[2] - mm.pos[2]); if (d < bd) { bd = d; b = x; } }
      if (b) {
        const o = [mm.pos[0], mm.pos[1] + 1.55, mm.pos[2]];
        const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
        const len = Math.hypot(...d) || 1;
        if (bd < 10) ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
        // close on the nearest bug so the point-blank cone connects; if it gets
        // too close, dive through it to reset distance and dodge the bite
        const tx = b.pos[0] - mm.pos[0], tz = b.pos[2] - mm.pos[2], tl = Math.hypot(tx, tz) || 1;
        if (bd > 6) {
          ws.send(JSON.stringify({ type: 'state', pos: [mm.pos[0] + (tx / tl) * 0.5, mm.pos[1], mm.pos[2] + (tz / tl) * 0.5], yaw: 0, pitch: 0, anim: 3 }));
        } else if (bd < 3) {
          ws.send(JSON.stringify({ type: 'dive', dir: [tx / tl, 0, tz / tl] }));
        }
      }
    }
    await sleep(90);
  }
  if (!kill) fail('shotgun never killed a bug');
  ok('shotgun kills confirmed');

  // loadout gating, while shooting + fleeing to stay alive long enough.
  // shoot the swarm to survive; flee the nearest bug.
  const survive = () => {
    const mm = me(); if (!mm) return;
    if (mm.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
    let b = null, bd = Infinity;
    for (const x of snapshot.bugs) { const d = Math.hypot(x.pos[0] - mm.pos[0], x.pos[2] - mm.pos[2]); if (d < bd) { bd = d; b = x; } }
    if (b) {
      const o = [mm.pos[0], mm.pos[1] + 1.55, mm.pos[2]];
      const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
      const len = Math.hypot(...d) || 1;
      ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
      const ax = mm.pos[0] - b.pos[0], az = mm.pos[2] - b.pos[2], al = Math.hypot(ax, az) || 1;
      ws.send(JSON.stringify({ type: 'state', pos: [mm.pos[0] + (ax / al) * 0.5, mm.pos[1], mm.pos[2] + (az / al) * 0.5], yaw: 0, pitch: 0, anim: 3 }));
      if (bd < 7) ws.send(JSON.stringify({ type: 'dive', dir: [ax / al, 0, az / al] }));
    }
  };

  // NAPALM (not brought) must be rejected
  let napalmCalled = 0;
  let g0 = Date.now();
  while (Date.now() - g0 < 4500) {
    survive();
    if (Date.now() - napalmCalled > 1500) { const mm = me(); if (mm) ws.send(JSON.stringify({ type: 'stratagem', kind: 'NAPALM', target: [mm.pos[0] + 3, 0, mm.pos[2]] })); napalmCalled = Date.now(); }
    await sleep(90);
  }
  if (napalmZone) fail('NAPALM fired despite not being in the loadout');
  ok('un-equipped stratagem (NAPALM) correctly rejected');

  // ORBITAL (brought) must fire
  let orbCalled = 0;
  g0 = Date.now();
  while (Date.now() - g0 < 12000 && !orbitalBoom) {
    survive();
    if (Date.now() - orbCalled > 4500) { const mm = me(); if (mm) ws.send(JSON.stringify({ type: 'stratagem', kind: 'ORBITAL', target: [mm.pos[0] + 12, 0, mm.pos[2]] })); orbCalled = Date.now(); }
    await sleep(90);
  }
  if (!orbitalBoom) fail('equipped stratagem (ORBITAL) did not fire');
  ok('equipped stratagem (ORBITAL) fired');

  console.log('\nLOADOUT TEST PASS — weapon stats + stratagem loadout gating verified.');
  clearTimeout(deadline);
  killServer();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
