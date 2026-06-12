# HELLDIVE

A Helldivers-2-inspired co-op third-person shooter that runs in the browser
(desktop + iPhone Safari) with a native Swift/SceneKit iOS client in progress —
all driven by one authoritative multiplayer server.

Dark cinematic nights, bug swarms, friendly fire, and stratagems you punch in
with arrow codes. For Managed Democracy.

```
┌─────────────┐     JSON over WebSocket      ┌──────────────────┐
│  Web client │ ◄──────────────────────────► │                  │
│  Three.js   │   state @20Hz / snaps @15Hz  │   Node server    │
└─────────────┘                              │  (authoritative) │
┌─────────────┐                              │  · bug AI        │
│ iOS client  │ ◄──────────────────────────► │  · hitscan       │
│  SceneKit   │      same protocol           │  · stratagems    │
└─────────────┘                              │  · mission FSM   │
       ▲                                     └──────────────────┘
       └── shared/ : protocol, tuning, deterministic worldgen (seed → terrain)
```

The server owns every gameplay outcome (enemies, damage, objectives); clients
render, predict their own movement, and replay server events as effects. That
is what makes one game logic serve two render clients — the Swift client is a
second *view*, not a second game.

## Run it

```bash
npm install
npm run dev          # server :8080 + vite dev server :5173 (LAN-exposed)
```

Open http://localhost:5173 — **NEW SQUAD** → share the 4-letter code (or the
URL, the code is in the hash). Squadmates can hot-join mid-mission and arrive
by hellpod.

**On your iPhone (today, via Safari):** same Wi-Fi, browse to
`http://<your-LAN-IP>:5173`, add to Home Screen for fullscreen PWA. Touch
controls appear automatically; landscape recommended.

**Production single-port:**

```bash
npm run build && npm start          # everything on :8080
# or
docker build -t helldive . && docker run -p 8080:8080 helldive
```

Deploy the container to Fly.io/Railway/Render (any Node host with WebSocket
support) and put TLS in front — the client auto-upgrades to `wss://` on https.

## Controls

| | Desktop | Touch (iOS Safari) |
|---|---|---|
| Move / sprint | WASD / Shift | left stick / `»` toggle |
| Aim | mouse (click to lock) | drag right half |
| Fire | left button | `●` hold |
| Reload | R | `R` |
| Use / board | E | `USE` |
| Stratagem | T then WASD/arrows | `⛬` then arrow pad |

**Stratagems** — Reinforce `▲▼▶◀▲` (revive squadmates) · Orbital Strike `▶▶▲` ·
Resupply `▼▼▲▶`. Beacons land where you aim. Orbital strikes do not care who
is standing in the radius. Friendly fire is always on; it's tradition.

**Mission loop:** drop → eradicate quota → reach the beacon → activate →
defend until the shuttle lands → board before it leaves. Reinforce budget is
shared; if the whole squad is down, liberty weeps.

## Testing (no browser needed)

```bash
npm run typecheck    # web + server
npm run smoke        # boots server, 2 fake clients: rooms, combat, strats…
node scripts/playthrough.mjs   # plays an entire compressed mission to COMPLETE
```

The playthrough test independently re-derives the extraction pad position from
the mission seed — the same trick the Swift port uses (see `ios/PORTING.md`).

## Repo layout

```
shared/     protocol + tuning + deterministic worldgen (the contract)
server/     authoritative sim: rooms, bug AI, hitscan, stratagems, mission FSM
web/        Three.js client: cinematic night rendering, HUD, touch controls
ios/        Swift/SceneKit client scaffold + porting contract (needs a Mac)
scripts/    integration tests + icon generator
```

## Drop-in 3D models (optional)

The default look is procedural primitives sold by lighting. Want real assets?
Drop GLB files into `web/public/models/` (`soldier.glb`, `bug0.glb`,
`bug1.glb`) and they replace the primitives automatically — skeletal
`Idle/Run/Death` clips are picked up by name, models are auto-scaled and
grounded. See `web/public/models/README.md` for a one-line animated test
asset and CC0 pack sources (Kenney, Quaternius).

## Tech notes

- **Web bundle is ~150 KB gzipped** including Three.js (drop-in GLBs add
  their own size). The procedural look leans on lighting: moonlight +
  per-soldier flashlights, bloom, fog, film grain, glowing visors and bug
  abdomens.
- Netcode v1: client-authoritative movement with server speed/collision
  validation (PvE — responsiveness over cheat-proofing), server-authoritative
  everything else. Snapshot interpolation 120 ms; JSON protocol (upgrade path:
  binary).
- Mobile budget: capped pixel ratio, no shadows, reduced particles — tuned for
  60 fps on recent iPhones in Safari.

## Roadmap

1. **Polish pass on feel** — recoil patterns, dive/prone, grenades, more weapons.
2. **iOS native client** (`ios/`) — first compile on a Mac, then effects parity.
3. More enemy types (spitters, chargers), nests as destructible objectives.
4. Binary snapshots + delta compression when squads grow past 4.
5. Persistence: loadouts, ship upgrades, galactic-war-style meta layer.
