// Verifies the new stratagems end to end: Sentry Gun deploys and fires,
// Napalm Barrage creates a burning zone that kills, Recon Pulse broadcasts.

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8143;
const OVERRIDES = {
  killBase: 120, killPerExtraPlayer: 0, // stay in KILL the whole test
  bugCapBase: 14, spawnIntervalS: 0.22, dropDurationS: 0.5,
};

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 60s timeout'), 60_000);
function fail(why) { console.error(`\nSTRATAGEM TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let self = '';
const seen = { sentry: false, sentryFire: false, fire: false, recon: false, burnKill: false };
let firing = false; // true while a napalm zone is up, to attribute kills

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
      if (m.sentries && m.sentries.length) seen.sentry = true;
      if (m.fires && m.fires.length) seen.fire = true;
    }
    if (m.type === 'sentryFire') seen.sentryFire = true;
    if (m.type === 'recon') seen.recon = true;
    if (m.type === 'bugDeath' && firing) seen.burnKill = true;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Tactician' }));

  const me = () => snapshot?.players.find((p) => p.id === self);
  const call = (kind, tx, tz) => ws.send(JSON.stringify({ type: 'stratagem', kind, target: [tx, 0, tz] }));
  const nearestBug = () => {
    const m = me(); if (!m || !snapshot.bugs.length) return null;
    let b = null, bd = Infinity;
    for (const x of snapshot.bugs) { const d = Math.hypot(x.pos[0] - m.pos[0], x.pos[2] - m.pos[2]); if (d < bd) { bd = d; b = x; } }
    return b;
  };

  // wait for the fight to be going (bugs near the player)
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const m = me();
    if (m && snapshot.bugs.some((b) => Math.hypot(b.pos[0] - m.pos[0], b.pos[2] - m.pos[2]) < 35)) break;
    // shoot nearest to stay alive while bugs close in
    const b = nearestBug();
    if (m && b) {
      const o = [m.pos[0], m.pos[1] + 1.55, m.pos[2]];
      const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
      const len = Math.hypot(...d) || 1;
      if (m.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
      ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
    }
    await sleep(120);
  }
  ok('fight underway, bugs in range');

  // RECON — instant ping
  call('RECON', me().pos[0] + 5, me().pos[2] + 5);
  await sleep(800);
  if (!seen.recon) fail('no recon event');
  ok('recon pulse broadcast');

  // SENTRY at our feet — bugs stream in and it should open fire
  call('SENTRY', me().pos[0], me().pos[2]);
  const sentryDeadline = Date.now() + 12000;
  while (Date.now() < sentryDeadline && !(seen.sentry && seen.sentryFire)) {
    // keep shooting so we survive
    const m = me(); const b = nearestBug();
    if (m && b) {
      const o = [m.pos[0], m.pos[1] + 1.55, m.pos[2]];
      const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
      const len = Math.hypot(...d) || 1;
      if (m.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
      ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
    }
    await sleep(120);
  }
  if (!seen.sentry) fail('sentry never appeared in snapshot');
  if (!seen.sentryFire) fail('sentry never opened fire');
  ok('sentry deployed and firing');

  // NAPALM on a bug cluster — should burn and kill
  const target = nearestBug();
  if (target) call('NAPALM', target.pos[0], target.pos[2]);
  firing = true;
  const napalmDeadline = Date.now() + 10000;
  while (Date.now() < napalmDeadline && !(seen.fire && seen.burnKill)) {
    const m = me(); const b = nearestBug();
    if (m && b) {
      const o = [m.pos[0], m.pos[1] + 1.55, m.pos[2]];
      const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
      const len = Math.hypot(...d) || 1;
      if (m.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
      // shoot away from the fire so kills are attributable to the burn
      ws.send(JSON.stringify({ type: 'fire', origin: o, dir: [0, 0.5, 0] }));
    }
    await sleep(120);
  }
  if (!seen.fire) fail('napalm zone never appeared');
  ok('napalm zone burning');
  if (!seen.burnKill) fail('napalm never killed anything');
  ok('napalm burned bugs to death');

  console.log('\nSTRATAGEM TEST PASS — sentry, napalm and recon verified.');
  clearTimeout(deadline);
  killServer();
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
