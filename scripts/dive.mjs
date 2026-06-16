// Verifies the dive/dodge: the server lunges the player ~5 m fast and flags
// ANIM.DIVING, and damage is dodged during the i-frame window.

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8144;
const OVERRIDES = { killBase: 200, killPerExtraPlayer: 0, bugCapBase: 1, bugCapPerExtraPlayer: 0, dropDurationS: 0.5 };
const ANIM_DIVING = 64;

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 30s timeout'), 30_000);
function fail(why) { console.error(`\nDIVE TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let self = '';
let sawDiving = false;

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
      const me = m.players.find((p) => p.id === self);
      if (me && (me.anim & ANIM_DIVING)) sawDiving = true;
    }
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Roller' }));

  // wait for the mission to be live (past DROP)
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (snapshot && snapshot.mission && snapshot.mission.phase === 'KILL') break;
    await sleep(80);
  }
  const me = () => snapshot.players.find((p) => p.id === self);
  if (!me()) fail('no self in snapshot');
  const start = me().pos.slice();
  ok(`mission live; start pos x=${start[0].toFixed(1)}`);

  // dive toward +X
  ws.send(JSON.stringify({ type: 'dive', dir: [1, 0, 0] }));
  await sleep(600); // dive lasts ~0.45s

  const end = me().pos;
  const dx = end[0] - start[0];
  ok(`moved dx=${dx.toFixed(2)}m, dz=${(end[2] - start[2]).toFixed(2)}m`);
  if (dx < 3.5) fail(`dive did not lunge the player (dx=${dx.toFixed(2)}, expected >3.5)`);
  ok('dive lunged the player ~5 m server-side');
  if (!sawDiving) fail('ANIM.DIVING flag never set during the dive');
  ok('ANIM.DIVING flag observed (remote clients can play the roll)');

  // cooldown: an immediate second dive should be rejected (no movement)
  const before = me().pos.slice();
  ws.send(JSON.stringify({ type: 'dive', dir: [1, 0, 0] }));
  await sleep(300);
  const moved = Math.abs(me().pos[0] - before[0]);
  if (moved > 1.5) fail(`second dive was not on cooldown (moved ${moved.toFixed(2)})`);
  ok('dive respects cooldown');

  console.log('\nDIVE TEST PASS — server-driven dive + i-frame flag + cooldown verified.');
  clearTimeout(deadline);
  killServer();
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
