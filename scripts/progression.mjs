// Verifies the progression system end to end:
//  - a pre-seeded profile loads from disk and resolves to the right level/unlocks
//  - a locked weapon is rejected (falls back to the rifle), an unlocked one equips
//  - kills earn XP that is banked into the profile and reported via `progress`
//  - the updated XP is persisted back to disk on a clean shutdown
// Runs against an isolated HD_DATA_DIR so it never touches real save data.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8147;
const PID = 'testpid-veteran-0001'; // pre-seeded account
const SEED_XP = 300; // -> level 3 (rifle+smg+shotgun unlocked; mg/sniper locked)
const OVERRIDES = { killBase: 999, killPerExtraPlayer: 0, bugCapBase: 8, spawnIntervalS: 0.25, dropDurationS: 0.5, reinforceBase: 0, reinforcePerExtraPlayer: 0, resetDelayS: 1 };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prog-'));
fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify([
  { pid: PID, name: 'Vet', xp: SEED_XP, kills: 0, missions: 0, created: Date.now(), updated: Date.now() },
]));

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_OBJECTIVE: 'ERADICATE', HD_DATA_DIR: dataDir, HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);
const deadline = setTimeout(() => fail('global 70s timeout'), 70_000);
function fail(why) { console.error(`\nPROGRESSION TEST FAIL: ${why}`); killServer(); process.exit(1); }
const ok = (w) => console.log(`  ok: ${w}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let snapshot = null;
let self = '';
let welcome = null;
let progress = null;
let killsByMe = 0;

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
    if (m.type === 'welcome') { self = m.self; welcome = m; }
    if (m.type === 'snapshot') snapshot = m;
    if (m.type === 'bugDeath' && m.by === self) killsByMe++;
    if (m.type === 'progress') progress = m;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', v: 1, name: 'Vet', pid: PID }));

  const me = () => snapshot?.players.find((p) => p.id === self);

  // 1) the pre-seeded profile loaded from disk and resolved correctly
  for (let i = 0; i < 40 && !welcome; i++) await sleep(80);
  if (!welcome) fail('no welcome');
  if (welcome.profile.level !== 3) fail(`level is ${welcome.profile.level}, expected 3 for ${SEED_XP} xp`);
  if (!welcome.profile.unlocked.includes('shotgun')) fail('shotgun should be unlocked at level 3');
  if (welcome.profile.unlocked.includes('sniper')) fail('sniper must stay locked at level 3');
  ok(`profile loaded from disk: rank ${welcome.profile.level}, unlocked [${welcome.profile.unlocked.join(', ')}]`);

  // 2) a locked weapon (sniper, lvl 7) must fall back to the rifle
  ws.send(JSON.stringify({ type: 'loadout', weapon: 'sniper', stratagems: ['ORBITAL'] }));
  ws.send(JSON.stringify({ type: 'start' }));
  for (let i = 0; i < 60; i++) { if (snapshot?.mission?.phase === 'KILL') break; await sleep(80); }
  if (me()?.weapon !== 'rifle') fail(`locked sniper equipped as ${me()?.weapon}, expected rifle fallback`);
  ok('locked weapon (sniper) rejected → rifle fallback');

  // 3) rack up kills with the rifle, then charge the swarm unarmed to die on
  //    purpose (solo death -> FAILED -> rewards). Walking into bugs is far more
  //    reliable than waiting for the next wave to reach a passive bot.
  const t0 = Date.now();
  while (Date.now() - t0 < 32000 && !progress) {
    const mm = me();
    const phase = snapshot?.mission?.phase;
    if (mm && phase === 'KILL') {
      let b = null, bd = Infinity;
      for (const x of snapshot.bugs) { const d = Math.hypot(x.pos[0] - mm.pos[0], x.pos[2] - mm.pos[2]); if (d < bd) { bd = d; b = x; } }
      const earning = killsByMe < 4 && Date.now() - t0 < 6000;
      if (b && earning) {
        if (mm.ammo === 0) ws.send(JSON.stringify({ type: 'reload' }));
        const o = [mm.pos[0], mm.pos[1] + 1.55, mm.pos[2]];
        const d = [b.pos[0] - o[0], b.pos[1] - o[1], b.pos[2] - o[2]];
        const len = Math.hypot(...d) || 1;
        ws.send(JSON.stringify({ type: 'fire', origin: o, dir: d.map((v) => v / len) }));
      } else if (b) {
        // weapon down: close to melee range then hold there so the bug keeps
        // biting (standing in contact prevents HP regen) — a sure, quick death
        const dx = b.pos[0] - mm.pos[0], dz = b.pos[2] - mm.pos[2], dl = Math.hypot(dx, dz) || 1;
        const step = dl > 1.4 ? 0.34 : 0; // hold once adjacent
        ws.send(JSON.stringify({ type: 'state', pos: [mm.pos[0] + (dx / dl) * step, mm.pos[1], mm.pos[2] + (dz / dl) * step], yaw: Math.atan2(dx, dz), pitch: 0, anim: 1 }));
      }
    }
    await sleep(80);
  }
  if (!progress) fail('no progress message at mission end');
  if (killsByMe === 0) fail('bot never killed a bug, cannot verify XP');
  if (progress.xpGained <= 0) fail(`xpGained is ${progress.xpGained}, expected > 0 from kills`);
  if (progress.profile.xp <= SEED_XP) fail(`profile xp ${progress.profile.xp} did not grow from ${SEED_XP}`);
  const earnedXp = progress.profile.xp;
  ok(`earned ${progress.xpGained} XP from ${killsByMe} kills (profile xp ${SEED_XP} → ${earnedXp})`);

  // 4) back in the lobby, an unlocked weapon (shotgun, lvl 3) equips for real
  for (let i = 0; i < 60; i++) { if (snapshot?.mission?.phase === 'LOBBY') break; await sleep(80); }
  ws.send(JSON.stringify({ type: 'loadout', weapon: 'shotgun', stratagems: ['ORBITAL'] }));
  ws.send(JSON.stringify({ type: 'start' }));
  for (let i = 0; i < 60; i++) { if (snapshot?.mission?.phase === 'KILL') break; await sleep(80); }
  if (me()?.weapon !== 'shotgun') fail(`unlocked shotgun did not equip (got ${me()?.weapon})`);
  ok('unlocked weapon (shotgun) equipped');

  // 5) a clean shutdown must flush the earned XP to disk
  ws.close();
  process.kill(-server.pid, 'SIGTERM'); // graceful: triggers profile flush
  for (let i = 0; i < 40; i++) { if (server.exitCode !== null || server.signalCode) break; await sleep(80); }
  await sleep(200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
  const vet = onDisk.find((p) => p.pid === PID);
  if (!vet) fail('veteran profile missing from disk after shutdown');
  if (vet.xp < earnedXp) fail(`disk xp ${vet.xp} < earned ${earnedXp} — flush did not persist`);
  ok(`earned XP persisted to disk (xp ${vet.xp})`);

  console.log('\nPROGRESSION TEST PASS — XP, levels, unlock gating and persistence verified.');
  clearTimeout(deadline);
  killServer();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
