// Full-mission integration test: two clients play a complete (time-compressed)
// mission — kill phase, a friendly-fire casualty + REINFORCE, extraction
// activation, defend, shuttle boarding, mission COMPLETE, lobby reset.

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8125;
const OVERRIDES = {
  killBase: 2,
  bugCapBase: 2,
  spawnIntervalS: 0.4,
  dropDurationS: 1,
  defendDurationS: 4,
  boardGraceS: 3,
  resetDelayS: 2,
};

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HD_MISSION_OVERRIDES: JSON.stringify(OVERRIDES) },
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
});
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} };
process.on('exit', killServer);

const deadline = setTimeout(() => fail('global 90s timeout'), 90_000);

function fail(why) {
  console.error(`\nPLAYTHROUGH FAIL: ${why}`);
  killServer();
  process.exit(1);
}
const ok = (what) => console.log(`  ok: ${what}`);

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.snapshot = null;
    this.selfId = '';
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'welcome') this.selfId = m.self;
        if (m.type === 'snapshot') this.snapshot = m;
        this.msgs.push(m);
        this.waiters = this.waiters.filter(([pred, res]) => (pred(m) ? (res(m), false) : true));
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  me() { return this.snapshot?.players.find((p) => p.id === this.selfId); }
  expect(pred, what, timeoutMs = 20000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${what}`)), timeoutMs);
      this.waiters.push([pred, (m) => { clearTimeout(t); resolve(m); }]);
    });
  }
  expectPhase(phase, timeoutMs = 25000) {
    return this.expect(
      (m) => (m.type === 'phase' || m.type === 'snapshot') && m.mission?.phase === phase,
      `phase ${phase}`,
      timeoutMs,
    );
  }
  async walkTo(x, z, timeoutS = 30) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutS * 1000) {
      const me = this.me();
      if (!me) { await sleep(60); continue; }
      const dx = x - me.pos[0];
      const dz = z - me.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 2.5) return;
      const step = Math.min(0.34, d);
      this.send({
        type: 'state',
        pos: [me.pos[0] + (dx / d) * step, me.pos[1], me.pos[2] + (dz / d) * step],
        yaw: Math.atan2(dx, dz), pitch: 0, anim: 3,
      });
      await sleep(46);
    }
    throw new Error(`walkTo(${x.toFixed(0)},${z.toFixed(0)}) timed out`);
  }
  shootAt(target) {
    const me = this.me();
    if (!me) return;
    const o = [me.pos[0], me.pos[1] + 1.55, me.pos[2]];
    const d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
    const len = Math.hypot(...d) || 1;
    if (me.ammo === 0) this.send({ type: 'reload' });
    this.send({ type: 'fire', origin: o, dir: d.map((v) => v / len) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // wait for server
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) break;
    } catch {}
    await sleep(200);
    if (i === 59) fail('server never healthy');
  }

  const a = new Client('Alpha');
  const b = new Client('Bravo');
  await a.connect();
  a.send({ type: 'join', v: 1, name: 'Alpha' });
  const w = await a.expect((m) => m.type === 'welcome', 'welcome A');
  await b.connect();
  b.send({ type: 'join', v: 1, name: 'Bravo', room: w.room });
  await b.expect((m) => m.type === 'welcome', 'welcome B');
  ok('squad of two assembled');

  a.send({ type: 'start' });
  await a.expectPhase('KILL');
  ok('mission started → KILL phase');

  // aimbot through the kill quota
  const killTimer = setInterval(() => {
    const me = a.me();
    const bug = a.snapshot?.bugs[0]
      ? a.snapshot.bugs.reduce((best, x) => {
          const d = (p) => Math.hypot(p.pos[0] - me.pos[0], p.pos[2] - me.pos[2]);
          return d(x) < d(best) ? x : best;
        })
      : null;
    if (me && bug) a.shootAt(bug.pos);
  }, 120);
  await a.expectPhase('EXTRACT', 40000);
  clearInterval(killTimer);
  ok('kill quota reached → EXTRACT phase');

  // friendly fire: Alpha guns down Bravo (for science), then reinforces
  const bPos = () => a.snapshot.players.find((p) => p.id === b.selfId).pos;
  const ffTimer = setInterval(() => {
    const t = bPos();
    a.shootAt([t[0], t[1] + 1.1, t[2]]);
  }, 120);
  await a.expect((m) => m.type === 'down' && m.id === b.selfId, 'Bravo down by friendly fire', 15000);
  clearInterval(ffTimer);
  ok('friendly fire confirmed (sorry, Bravo)');

  const aPos = a.me().pos;
  a.send({ type: 'stratagem', kind: 'REINFORCE', target: [aPos[0] + 2, aPos[1], aPos[2]] });
  const rf = await a.expect((m) => m.type === 'reinforced', 'reinforce resolves', 10000);
  if (!rf.ids.includes(b.selfId)) fail('reinforce did not revive Bravo');
  ok('REINFORCE revived Bravo');

  // walk to the extraction pad and activate the beacon
  const padMsg = await a.expect((m) => m.type === 'snapshot', 'snapshot');
  void padMsg;
  // pad position must be derived the same way the server does — easiest is to
  // walk toward where interact succeeds; the server tells us via DEFEND phase.
  // We compute it from the seed exactly like shared/world.ts padPosition().
  const seed = a.snapshot.mission.seed >>> 0;
  const mb32 = (s) => {
    let aa = s >>> 0;
    return () => {
      aa = (aa + 0x6d2b79f5) >>> 0;
      let t = aa;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const rng = mb32((seed ^ 0x5add) >>> 0);
  const ang = rng() * Math.PI * 2;
  const dist = 62 + rng() * 18;
  const pad = { x: Math.cos(ang) * dist, z: Math.sin(ang) * dist };
  ok(`pad located at (${pad.x.toFixed(0)}, ${pad.z.toFixed(0)}) — walking`);

  await a.walkTo(pad.x, pad.z, 40);
  a.send({ type: 'interact' });
  await a.expectPhase('DEFEND', 8000);
  ok('extraction beacon activated → DEFEND phase');

  await a.expectPhase('BOARD', 15000);
  await a.expect((m) => m.type === 'boom' && m.kind === 'SHUTTLE', 'shuttle announced');
  ok('shuttle landed → BOARD phase');

  // Alpha boards; Bravo dawdles and gets left behind
  await a.walkTo(pad.x, pad.z, 10).catch(() => {});
  a.send({ type: 'interact' });
  await a.expect((m) => m.type === 'boarded' && m.id === a.selfId, 'Alpha boarded', 8000);
  ok('Alpha aboard');

  await a.expectPhase('COMPLETE', 15000);
  ok('mission COMPLETE (Bravo is MIA — a small price for democracy)');

  await a.expectPhase('LOBBY', 15000);
  ok('room reset to LOBBY for the next dive');

  console.log('\nPLAYTHROUGH PASS — full mission loop verified.');
  clearTimeout(deadline);
  killServer();
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
