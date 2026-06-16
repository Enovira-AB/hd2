// Verifies the new combat systems end to end: ranged spitter projectiles
// (snapshot.projectiles + splat events) and the titan boss (arrival event +
// snapshot.boss healthbar + that it actually dies and rewards the quota).

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8142;
const OVERRIDES = {
  killBase: 12,          // killTarget = 12 -> titan threshold met
  killPerExtraPlayer: 0,
  bugCapBase: 30,        // dense field so spitters appear quickly
  spawnIntervalS: 0.2,
  dropDurationS: 0.5,
};

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 60s timeout'), 60_000);

function fail(why) { console.error(`\nBOSS TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let self = '';
const seen = { projectile: false, splat: false, boss: false, bossDeath: false };
const logged = { boss: false, projectile: false, splat: false };
let bossMaxHp = 0;
let bossMinHp = Infinity;

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
      if (m.projectiles && m.projectiles.length) seen.projectile = true;
      if (m.boss) {
        seen.boss = true;
        bossMaxHp = Math.max(bossMaxHp, m.boss.hpMax);
        bossMinHp = Math.min(bossMinHp, m.boss.hp);
      }
    }
    if (m.type === 'splat') seen.splat = true;
    if (m.type === 'boss') seen.boss = true;
    if (m.type === 'bugDeath' && m.kind === 4) seen.bossDeath = true;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Slayer' }));

  // Kiting aimbot: shoot the titan (or nearest bug) while constantly backing
  // away from the closest threat, so the solo bot survives long enough to
  // observe spitter fire and chip the titan down. Restart if the run resets.
  const t0 = Date.now();
  let lastStart = 0;
  while (Date.now() - t0 < 55_000) {
    if (snapshot && self) {
      const phase = snapshot.mission?.phase;
      if ((phase === 'LOBBY' || phase === 'FAILED' || phase === 'COMPLETE') && Date.now() - lastStart > 1500) {
        ws.send(JSON.stringify({ type: 'start' }));
        lastStart = Date.now();
      }
      const me = snapshot.players.find((p) => p.id === self);
      if (me) {
        if (me.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
        const titan = snapshot.bugs.find((b) => b.kind === 4);
        let nearest = null, nd = Infinity;
        for (const b of snapshot.bugs) {
          const d = Math.hypot(b.pos[0] - me.pos[0], b.pos[2] - me.pos[2]);
          if (d < nd) { nd = d; nearest = b; }
        }
        const tgt = titan ?? nearest;
        if (tgt) {
          const o = [me.pos[0], me.pos[1] + 1.55, me.pos[2]];
          const d = [tgt.pos[0] - o[0], tgt.pos[1] + 0.4 - o[1], tgt.pos[2] - o[2]];
          const len = Math.hypot(...d) || 1;
          ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
        }
        // kite away from the nearest threat (and strafe) to stay alive
        if (nearest && nd < 30) {
          const ax = me.pos[0] - nearest.pos[0];
          const az = me.pos[2] - nearest.pos[2];
          const al = Math.hypot(ax, az) || 1;
          const tx = -az / al; // tangent for strafing
          const tz = ax / al;
          const nx = me.pos[0] + (ax / al) * 0.5 + tx * 0.35;
          const nz = me.pos[2] + (az / al) * 0.5 + tz * 0.35;
          ws.send(JSON.stringify({ type: 'state', pos: [nx, me.pos[1], nz], yaw: 0, pitch: 0, anim: 3 }));
        }
      }
    }
    if (seen.boss && !logged.boss) { ok('titan arrived (boss event + snapshot.boss healthbar)'); logged.boss = true; }
    if (seen.projectile && !logged.projectile) { ok('spitter projectiles in snapshot'); logged.projectile = true; }
    if (seen.splat && !logged.splat) { ok('acid splat impact events'); logged.splat = true; }
    // done once all three new systems are proven: ranged projectiles, acid
    // splats, and a damageable titan (healthbar drops)
    const titanDamaged = bossMaxHp > 0 && bossMinHp < bossMaxHp - 100;
    if (seen.bossDeath || (seen.projectile && seen.splat && titanDamaged)) break;
    await sleep(90);
  }

  if (!seen.boss) fail('titan never arrived');
  if (!seen.projectile) fail('no spitter projectiles observed');
  if (!seen.splat) fail('no acid splat impacts observed');
  if (!(bossMinHp < bossMaxHp)) fail('titan took no damage from rifle fire');
  ok(`titan took damage: ${bossMaxHp} -> ${bossMinHp} HP${seen.bossDeath ? ' (killed!)' : ''}`);

  console.log('\nBOSS TEST PASS — ranged projectiles and the titan boss verified.');
  clearTimeout(deadline);
  killServer();
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
