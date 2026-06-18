// Verifies the NESTS objective: nests are destructible, sealing them all
// completes the kill phase (-> EXTRACT). HD_NEST_HP shrinks nest HP so the
// run is quick and deterministic.

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8145;
const OVERRIDES = { killBase: 999, killPerExtraPlayer: 0, bugCapBase: 0, bugCapPerExtraPlayer: 0, spawnIntervalS: 0.5, dropDurationS: 0.5 };

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  // NEST_HP 34 = one rifle round per nest, so the run is bounded by navigation,
  // not shooting (keeps it from timing out under heavy parallel test load).
  env: { ...process.env, PORT: String(PORT), HD_OBJECTIVE: 'NESTS', HD_NEST_HP: '34', HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 110s timeout'), 110_000);
function fail(why) { console.error(`\nNEST TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let self = '';
let nestDeaths = 0;
let reachedExtract = false;

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
    if (m.type === 'welcome') { self = m.self; ws.send(JSON.stringify({ type: 'start' })); }
    if (m.type === 'snapshot') {
      snapshot = m;
      if (m.mission?.phase === 'EXTRACT') reachedExtract = true;
    }
    if (m.type === 'nestDeath') nestDeaths++;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Demolisher' }));

  const me = () => snapshot?.players.find((p) => p.id === self);

  // wait for KILL phase, verify objective + nests present
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (snapshot?.mission?.phase === 'KILL') break;
    await sleep(80);
  }
  if (snapshot.mission.objective !== 'NESTS') fail(`objective is ${snapshot.mission.objective}, expected NESTS`);
  if (!snapshot.nests || !snapshot.nests.length) fail('no nests in snapshot');
  const total = snapshot.mission.nestsTotal;
  ok(`NESTS objective, ${total} nests to seal`);

  // Approach the nearest live nest and shoot it. The bot shoots from rifle range
  // (no need to hug the nest) and sidesteps when it stalls against a rock, so a
  // nest tucked behind cover can't trap it. Repeat until EXTRACT.
  let prevNd = Infinity, stallSince = Date.now(), strafeUntil = 0, strafeSign = 1;
  while (Date.now() - t0 < 95000 && !reachedExtract) {
    const m = me();
    if (!m) { await sleep(80); continue; }
    if (m.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
    const nests = snapshot.nests ?? [];
    if (nests.length === 0) { await sleep(80); continue; }
    // nearest live nest
    let n = nests[0], nd = Infinity;
    for (const x of nests) { const d = Math.hypot(x.pos[0] - m.pos[0], x.pos[2] - m.pos[2]); if (d < nd) { nd = d; n = x; } }

    // fire whenever it's in comfortable rifle range (one round seals it)
    if (nd < 45) {
      const o = [m.pos[0], m.pos[1] + 1.55, m.pos[2]];
      const d = [n.pos[0] - o[0], n.pos[1] + 1.0 - o[1], n.pos[2] - o[2]];
      const len = Math.hypot(...d) || 1;
      ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
    }

    // stall detection: if we haven't gained ground in 1.6 s, strafe around cover
    const now = Date.now();
    if (prevNd - nd > 0.4) { stallSince = now; prevNd = nd; }
    if (now - stallSince > 1600 && now > strafeUntil) { strafeUntil = now + 1100; strafeSign = -strafeSign; stallSince = now; }

    if (nd > 12) {
      const dx = n.pos[0] - m.pos[0], dz = n.pos[2] - m.pos[2], d = Math.hypot(dx, dz) || 1;
      let mx = dx / d, mz = dz / d;
      if (now < strafeUntil) { mx = (-dz / d) * strafeSign; mz = (dx / d) * strafeSign; } // perpendicular
      ws.send(JSON.stringify({ type: 'state', pos: [m.pos[0] + mx * 0.66, m.pos[1], m.pos[2] + mz * 0.66], yaw: Math.atan2(dx, dz), pitch: 0, anim: 3 }));
    }
    await sleep(80);
  }

  if (nestDeaths === 0) fail('no nest was destroyed');
  ok(`destroyed ${nestDeaths}/${total} nests`);
  if (!reachedExtract) fail('sealing all nests did not advance to EXTRACT');
  ok('all nests sealed -> EXTRACT phase');

  console.log('\nNEST TEST PASS — destructible nests + NESTS objective verified.');
  clearTimeout(deadline);
  killServer();
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
