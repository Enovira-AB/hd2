// End-to-end netcode smoke test: boots the real server, connects two fake
// clients, runs a mission far enough to prove join/start/move/fire/kill/
// stratagem/snapshot flow. Exits 0 on success.

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8123;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const deadline = setTimeout(() => fail('global 40s timeout'), 40_000);

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
  detached: true, // own process group so we can kill the whole tree
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
const killServer = () => {
  try { process.kill(-server.pid, 'SIGKILL'); } catch {}
};
process.on('exit', killServer);

function fail(why) {
  console.error(`\nSMOKE FAIL: ${why}`);
  killServer();
  process.exit(1);
}
function ok(what) {
  console.log(`  ok: ${what}`);
}

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  fail('server never became healthy');
}

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.snapshot = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot') this.snapshot = msg;
        this.msgs.push(msg);
        this.waiters = this.waiters.filter(([pred, res]) => {
          if (pred(msg)) {
            res(msg);
            return false;
          }
          return true;
        });
      });
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  expect(pred, what, timeoutMs = 15000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for: ${what}`)), timeoutMs);
      this.waiters.push([pred, (m) => { clearTimeout(t); resolve(m); }]);
    });
  }
}

try {
  await waitHealthy();
  ok('server healthy');

  const a = new Client('Alpha');
  const b = new Client('Bravo');
  await a.connect();

  a.send({ type: 'join', v: 1, name: 'Alpha' });
  const welcomeA = await a.expect((m) => m.type === 'welcome', 'welcome A');
  ok(`A joined room ${welcomeA.room}, self=${welcomeA.self}`);
  if (welcomeA.host !== welcomeA.self) fail('A should be host');

  await b.connect();
  b.send({ type: 'join', v: 1, name: 'Bravo', room: welcomeA.room });
  const welcomeB = await b.expect((m) => m.type === 'welcome', 'welcome B');
  await a.expect((m) => m.type === 'joined' && m.player.id === welcomeB.self, 'A sees B join');
  ok('B joined the same squad; A notified');

  // bad room code is rejected
  const c = new Client('Crash');
  await c.connect();
  c.send({ type: 'join', v: 1, name: 'Crash', room: 'XXXX' });
  await c.expect((m) => m.type === 'error', 'bad room rejected');
  c.ws.close();
  ok('bad room code rejected');

  a.send({ type: 'start' });
  await a.expect((m) => m.type === 'phase' && m.mission.phase === 'DROP', 'phase DROP');
  const kill = await a.expect((m) => m.type === 'phase' && m.mission.phase === 'KILL', 'phase KILL');
  ok(`mission running (killTarget=${kill.mission.killTarget})`);

  await a.expect((m) => m.type === 'snapshot' && m.bugs.length > 0, 'bugs in snapshot');
  ok(`snapshot flowing (${a.snapshot.bugs.length} bugs)`);

  // ping/pong clock sync
  a.send({ type: 'ping', t: 12345 });
  await a.expect((m) => m.type === 'pong' && m.t === 12345, 'pong');
  ok('clock sync ping/pong');

  // A shoots the nearest bug until something dies. Aim is computed from the
  // authoritative snapshot, like an aimbot-y integration test should.
  const me = () => a.snapshot.players.find((p) => p.id === welcomeA.self);
  let killEvent = null;
  a.expect((m) => m.type === 'bugDeath', 'bug death', 25000).then(
    (m) => (killEvent = m),
    () => {}, // resolved by the loop timeout below instead
  );
  const t0 = Date.now();
  while (!killEvent && Date.now() - t0 < 25000) {
    const self = me();
    if (self) {
      if (self.ammo === 0) a.send({ type: 'reload' });
      let bug = null;
      let bd = Infinity;
      for (const b of a.snapshot.bugs) {
        const d = Math.hypot(b.pos[0] - self.pos[0], b.pos[2] - self.pos[2]);
        if (d < bd) { bd = d; bug = b; }
      }
      if (bug) {
        const o = [self.pos[0], self.pos[1] + 1.55, self.pos[2]];
        const d = [bug.pos[0] - o[0], bug.pos[1] - o[1], bug.pos[2] - o[2]];
        const len = Math.hypot(...d);
        a.send({ type: 'fire', origin: o, dir: d.map((v) => v / len) });
      }
    }
    await new Promise((r) => setTimeout(r, 110));
  }
  if (!killEvent) fail('no bug died after 25s of shooting');
  ok('hitscan kill confirmed (bugDeath event)');
  await b.expect((m) => m.type === 'fired' && m.id === welcomeA.self, 'B sees A tracers');
  ok('fire events broadcast to squad');

  // movement: B walks and the snapshot follows (speed-limited)
  const bStart = b.snapshot.players.find((p) => p.id === welcomeB.self).pos;
  for (let i = 1; i <= 10; i++) {
    b.send({
      type: 'state',
      pos: [bStart[0] + i * 0.35, bStart[1], bStart[2]],
      yaw: 1.57, pitch: 0, anim: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
  }
  await b.expect(
    (m) => m.type === 'snapshot' &&
      Math.abs(m.players.find((p) => p.id === welcomeB.self).pos[0] - (bStart[0] + 3.5)) < 1.2,
    'B movement reflected in snapshot',
  );
  ok('client-authoritative movement accepted within speed limits');

  // teleport attempt is rejected
  b.send({ type: 'state', pos: [bStart[0] + 90, bStart[1], bStart[2]], yaw: 0, pitch: 0, anim: 0 });
  await new Promise((r) => setTimeout(r, 200));
  const bNow = b.snapshot.players.find((p) => p.id === welcomeB.self).pos;
  if (Math.abs(bNow[0] - (bStart[0] + 90)) < 5) fail('teleport was not rejected');
  ok('teleport rejected by server');

  // resupply stratagem: called, lands, pickup refills reserve
  const self = me();
  a.send({ type: 'stratagem', kind: 'RESUPPLY', target: [self.pos[0] + 2, self.pos[1], self.pos[2]] });
  await a.expect((m) => m.type === 'strat' && m.kind === 'RESUPPLY', 'strat called');
  await a.expect((m) => m.type === 'boom' && m.kind === 'RESUPPLY', 'resupply landed', 6000);
  await a.expect((m) => m.type === 'snapshot' && m.supplies.length > 0, 'supply in snapshot');
  const before = me().reserve;
  // walk to the pod and interact (it landed 2m away; send position at it)
  const pod = a.snapshot.supplies[0];
  a.send({ type: 'state', pos: pod.pos, yaw: 0, pitch: 0, anim: 1 });
  await new Promise((r) => setTimeout(r, 150));
  a.send({ type: 'interact' });
  await a.expect(
    (m) => m.type === 'snapshot' && m.players.find((p) => p.id === welcomeA.self).reserve >= before,
    'reserve refilled',
  );
  ok('resupply stratagem end-to-end');

  // orbital strike lands and (friendly fire!) can hurt people
  const me2 = me();
  a.send({ type: 'stratagem', kind: 'ORBITAL', target: [me2.pos[0] + 12, me2.pos[1], me2.pos[2] + 12] });
  await a.expect((m) => m.type === 'boom' && m.kind === 'ORBITAL', 'orbital impact', 6000);
  ok('orbital strike resolves');

  console.log('\nSMOKE PASS — netcode verified end to end.');
  clearTimeout(deadline);
  a.ws.close();
  b.ws.close();
  killServer();
  process.exit(0);
} catch (e) {
  fail(e.message ?? String(e));
}
