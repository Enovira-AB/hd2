// WebSocket client: typed send/receive, server clock estimation and
// snapshot interpolation for remote entities.

import type {
  BugState,
  ClientMsg,
  MissionState,
  PlayerState,
  ServerMsg,
  SupplyState,
} from '../../shared/protocol.js';
import { INTERP_DELAY_MS, PROTOCOL_VERSION } from '../../shared/constants.js';

interface Snapshot {
  t: number;
  players: PlayerState[];
  bugs: BugState[];
  supplies: SupplyState[];
}

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private snapshots: Snapshot[] = [];
  private clockOffset = 0; // serverNow ≈ Date.now() + clockOffset
  private bestRtt = Infinity;
  private pingTimer: number | undefined;

  selfId = '';
  room = '';
  hostId = '';
  mission: MissionState | null = null;
  latestPlayers: PlayerState[] = [];
  latestSupplies: SupplyState[] = [];
  connected = false;

  on(type: ServerMsg['type'], fn: Handler) {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  connect(name: string, room?: string): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        this.send({ type: 'join', v: PROTOCOL_VERSION, name, room: room || undefined });
      };
      ws.onerror = () => {
        if (!settled) reject(new Error('Could not reach the game server'));
      };
      ws.onclose = () => {
        this.connected = false;
        this.dispatch({ type: 'error', reason: 'Connection lost' });
        if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMsg;
        if (msg.type === 'welcome') {
          this.selfId = msg.self;
          this.room = msg.room;
          this.hostId = msg.host;
          this.mission = msg.mission;
          this.latestPlayers = msg.players;
          this.connected = true;
          this.startPing();
          settled = true;
          resolve();
        } else if (msg.type === 'error' && !settled) {
          settled = true;
          reject(new Error(msg.reason));
          return;
        }
        this.ingest(msg);
        this.dispatch(msg);
      };
    });
  }

  private ingest(msg: ServerMsg) {
    switch (msg.type) {
      case 'snapshot':
        this.snapshots.push({ t: msg.t, players: msg.players, bugs: msg.bugs, supplies: msg.supplies });
        if (this.snapshots.length > 30) this.snapshots.shift();
        this.mission = msg.mission;
        this.latestPlayers = msg.players;
        this.latestSupplies = msg.supplies;
        break;
      case 'phase':
        this.mission = msg.mission;
        break;
      case 'left':
        this.hostId = msg.host;
        break;
      case 'pong': {
        const rtt = Date.now() - msg.t;
        if (rtt <= this.bestRtt + 30) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.clockOffset = msg.now + rtt / 2 - Date.now();
        }
        break;
      }
    }
  }

  private dispatch(msg: ServerMsg) {
    for (const fn of this.handlers.get(msg.type) ?? []) fn(msg);
  }

  private startPing() {
    const ping = () => this.send({ type: 'ping', t: Date.now() });
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  // Interpolated remote state at (serverNow - INTERP_DELAY_MS).
  sample(): { players: PlayerState[]; bugs: BugState[] } {
    const n = this.snapshots.length;
    if (n === 0) return { players: [], bugs: [] };
    if (n === 1) return { players: this.snapshots[0].players, bugs: this.snapshots[0].bugs };

    const renderT = this.serverNow() - INTERP_DELAY_MS;
    let s0 = this.snapshots[0];
    let s1 = this.snapshots[n - 1];
    for (let i = 0; i < n - 1; i++) {
      if (this.snapshots[i].t <= renderT && renderT <= this.snapshots[i + 1].t) {
        s0 = this.snapshots[i];
        s1 = this.snapshots[i + 1];
        break;
      }
    }
    if (renderT >= s1.t) {
      // fell behind (hiccup): hold latest rather than extrapolate
      return { players: s1.players, bugs: s1.bugs };
    }
    const span = Math.max(1, s1.t - s0.t);
    const a = Math.max(0, Math.min(1, (renderT - s0.t) / span));

    const players = s1.players.map((p1) => {
      const p0 = s0.players.find((p) => p.id === p1.id);
      if (!p0) return p1;
      return {
        ...p1,
        pos: lerp3(p0.pos, p1.pos, a),
        yaw: lerpAngle(p0.yaw, p1.yaw, a),
        pitch: p0.pitch + (p1.pitch - p0.pitch) * a,
      };
    });
    const bugs = s1.bugs.map((b1) => {
      const b0 = s0.bugs.find((b) => b.id === b1.id);
      if (!b0) return b1;
      return { ...b1, pos: lerp3(b0.pos, b1.pos, a), yaw: lerpAngle(b0.yaw, b1.yaw, a) };
    });
    return { players, bugs };
  }
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
