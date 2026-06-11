// HELLDIVE game server: serves the built web client and hosts the
// authoritative simulation over WebSocket (path /ws).

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMsg } from '../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../shared/constants.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8080);
const here = path.dirname(fileURLToPath(import.meta.url));
// works both from server/src (tsx) and dist/server/server/src (compiled)
const repoRoot = here.includes(`dist${path.sep}`)
  ? path.resolve(here, '../../../..')
  : path.resolve(here, '../..');
const webDist = path.join(repoRoot, 'dist', 'web');

const app = express();
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map<string, Room>();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

function createRoom(): Room {
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join('');
  } while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  room.onEmpty = () => {
    // grace period so a reconnect/refresh can reclaim the room
    setTimeout(() => {
      if (room.size === 0) {
        room.dispose();
        rooms.delete(code);
      }
    }, 60_000);
  };
  return room;
}

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;

  ws.on('message', (data) => {
    const msg = parseClientMsg(data.toString());
    if (!msg) return;

    if (msg.type === 'join') {
      if (room) return;
      if (msg.v !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ type: 'error', reason: 'Client/server version mismatch — refresh the page' }));
        return;
      }
      let target: Room | undefined;
      if (msg.room) {
        target = rooms.get(msg.room.toUpperCase().trim());
        if (!target) {
          ws.send(JSON.stringify({ type: 'error', reason: `No squad with code ${msg.room.toUpperCase()}` }));
          return;
        }
      } else {
        target = createRoom();
      }
      const player = target.addPlayer(ws, msg.name);
      if (player) room = target;
      return;
    }

    if (room) room.handle(ws, msg);
  });

  ws.on('close', () => {
    room?.removeSocket(ws);
    room = null;
  });
  ws.on('error', () => ws.close());
});

server.listen(PORT, () => {
  console.log(`HELLDIVE server on http://0.0.0.0:${PORT}  (ws: /ws)`);
  if (!fs.existsSync(webDist)) {
    console.log('dist/web not found — run `npm run build:web` to serve the client from this process.');
  }
});
