// Verifies the galactic war: a completed mission contributes liberation to the
// active planet, the `galaxy` broadcast + /galaxy endpoint reflect it, and the
// state is persisted to disk. Plays a full solo mission to COMPLETE.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8149;
const LIB_PER = 4; // GALAXY.libPerMission, ×1 at CHALLENGING (default tier)
const OVERRIDES = {
  killBase: 2, killPerExtraPlayer: 0, bugCapBase: 1, bugCapPerExtraPlayer: 0,
  spawnIntervalS: 0.4, dropDurationS: 1, defendDurationS: 4, boardGraceS: 3, resetDelayS: 2,
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-galaxy-'));
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_OBJECTIVE: 'ERADICATE', HD_DATA_DIR: dataDir, HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 90s timeout'), 90_000);
function fail(why) { console.error(`\nGALAXY TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null, self = '', galaxy = null, galaxyGain = null;
const msgs = [];
const waiters = [];
function onMsg(m) {
  if (m.type === 'welcome') { self = m.self; galaxy = m.galaxy; }
  if (m.type === 'snapshot') snapshot = m;
  if (m.type === 'galaxy') { galaxy = m.galaxy; galaxyGain = m.gained; }
  msgs.push(m);
  for (const w of waiters.splice(0)) (w.pred(m) ? w.res(m) : waiters.push(w));
}
const expect = (pred, what, ms = 25000) => {
  const f = msgs.find(pred); if (f) return Promise.resolve(f);
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms); waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } }); });
};
const expectPhase = (phase, ms) => expect((m) => (m.type === 'phase' || m.type === 'snapshot') && m.mission?.phase === phase, `phase ${phase}`, ms);

let ws;
const me = () => snapshot?.players.find((p) => p.id === self);
const send = (m) => ws.send(JSON.stringify(m));
function shootNearest() {
  const m = me(); if (!m || !snapshot?.bugs?.length) return;
  let b = null, bd = Infinity;
  for (const x of snapshot.bugs) { const d = Math.hypot(x.pos[0] - m.pos[0], x.pos[2] - m.pos[2]); if (d < bd) { bd = d; b = x; } }
  if (!b) return;
  if (m.ammo === 0) return send({ type: 'reload' });
  const o = [m.pos[0], m.pos[1] + 1.55, m.pos[2]];
  const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
  const len = Math.hypot(...d) || 1;
  send({ type: 'fire', origin: o, dir: d.map((v) => v / len) });
}
async function walkTo(x, z, timeoutS = 40) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const m = me();
    if (m) {
      const dx = x - m.pos[0], dz = z - m.pos[2], d = Math.hypot(dx, dz);
      if (d < 2.3) return;
      const step = Math.min(0.34, d);
      send({ type: 'state', pos: [m.pos[0] + (dx / d) * step, m.pos[1], m.pos[2] + (dz / d) * step], yaw: Math.atan2(dx, dz), pitch: 0, anim: 3 });
    }
    await sleep(48);
  }
  throw new Error(`walkTo(${x.toFixed(0)},${z.toFixed(0)}) timed out`);
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {}
    await sleep(200);
    if (i === 49) fail('server never healthy');
  }

  // 1) the war starts cold via the HTTP endpoint
  const g0 = await (await fetch(`http://127.0.0.1:${PORT}/galaxy`)).json();
  if (g0.missionsWon !== 0) fail(`fresh galaxy missionsWon ${g0.missionsWon}, expected 0`);
  const front0 = g0.planets.find((p) => p.id === g0.activePlanet);
  if (!front0 || front0.liberation !== 0) fail('fresh active planet should be at 0% liberation');
  ok(`galactic war cold-loaded via /galaxy (front: ${front0.name})`);

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('error', (e) => fail(`ws error: ${e.message}`));
  ws.on('message', (raw) => onMsg(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on('open', r));
  send({ type: 'join', v: 1, name: 'Diver' });
  await expect((m) => m.type === 'welcome', 'welcome');

  // keep us alive + clear the kill quota
  const shooter = setInterval(() => { const ph = snapshot?.mission?.phase; if (ph && ph !== 'LOBBY' && !me()?.boarded) shootNearest(); }, 100);

  send({ type: 'start' });
  await expectPhase('KILL');
  await expectPhase('EXTRACT', 45000);
  ok('kill quota cleared → EXTRACT');

  // derive the pad exactly like shared/world.ts and activate the beacon
  const seed = snapshot.mission.seed >>> 0;
  const mb32 = (s) => { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const rng = mb32((seed ^ 0x5add) >>> 0);
  const ang = rng() * Math.PI * 2, dist = 62 + rng() * 18;
  const pad = { x: Math.cos(ang) * dist, z: Math.sin(ang) * dist };
  await walkTo(pad.x, pad.z, 45);
  send({ type: 'interact' });
  await expectPhase('DEFEND', 10000);
  await expectPhase('BOARD', 16000);
  await expect((m) => m.type === 'boom' && m.kind === 'SHUTTLE', 'shuttle');
  ok('extraction held → BOARD');

  await walkTo(pad.x, pad.z, 12).catch(() => {});
  send({ type: 'interact' });
  await expect((m) => m.type === 'boarded' && m.id === self, 'boarded', 9000);

  // 2) the victory contributes liberation
  const gmsg = await expect((m) => m.type === 'galaxy', 'galaxy broadcast', 16000);
  await expectPhase('COMPLETE', 12000);
  clearInterval(shooter);
  if (!galaxyGain) fail('no galaxy gain reported');
  if (galaxy.missionsWon !== 1) fail(`missionsWon ${galaxy.missionsWon}, expected 1`);
  if (Math.abs(galaxyGain.liberation - LIB_PER) > 0.001) fail(`liberation ${galaxyGain.liberation}, expected ${LIB_PER}`);
  if (galaxyGain.planet !== g0.activePlanet) fail('liberation applied to the wrong planet');
  void gmsg;
  ok(`victory liberated +${LIB_PER}% of the front (missionsWon ${galaxy.missionsWon})`);

  // 3) the endpoint reflects the live state
  const g1 = await (await fetch(`http://127.0.0.1:${PORT}/galaxy`)).json();
  const front1 = g1.planets.find((p) => p.id === g1.activePlanet);
  if (g1.missionsWon !== 1 || Math.abs(front1.liberation - LIB_PER) > 0.001) fail('/galaxy did not reflect the contribution');
  ok('/galaxy endpoint reflects the new state');

  // 4) it survives a clean shutdown
  ws.close();
  process.kill(-server.pid, 'SIGTERM');
  for (let i = 0; i < 40; i++) { if (server.exitCode !== null || server.signalCode) break; await sleep(80); }
  await sleep(200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'galaxy.json'), 'utf8'));
  const frontD = onDisk.planets.find((p) => p.id === onDisk.activePlanet);
  if (onDisk.missionsWon !== 1 || Math.abs(frontD.liberation - LIB_PER) > 0.001) fail('galaxy not persisted to disk');
  ok(`galactic war persisted to disk (${frontD.name} at ${frontD.liberation}%)`);

  console.log('\nGALAXY TEST PASS — galactic-war contribution, broadcast and persistence verified.');
  clearTimeout(deadline);
  killServer();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
