# HELLDIVE — Design & Port Reference

Engine-agnostic spec for the game. The web build (Three.js + Node) is the
**source of truth for design**; this document captures the rules so the game
can be re-skinned in any engine (Unity, Unreal, Godot) without re-deriving them.

The golden rule of the architecture: **one authoritative simulation owns all
outcomes; clients only render and predict.** That is what lets the same game
run on a web client and (eventually) a native client at once.

---

## 1. Vision & differentiator

A co-op (1–4) third-person shooter: drop onto a hostile world, complete an
objective, extract. Friendly fire is always on. Heavily inspired by Helldivers,
but with one deliberate hook that Helldivers does **not** lean on:

> **It is always night, and the dark is a mechanic — not just a mood.**

- You read the battlefield by your flashlight cone and the enemies' own
  bioluminescence (glowing abdomens, eyes).
- Light is a weapon *and* a liability — it reveals enemies but draws them.
- **Lightning storms** flash-reveal the whole field for a beat; you plan in the
  strobe. Thunder trails the flash. Rain and a swelling tension drone complete
  the dread.

Everything else (stratagems, swarms, extraction, a boss) is the familiar loop;
the night is the identity.

---

## 2. Architecture (the engine-agnostic core)

```
            authoritative server (30 Hz)
            ├─ deterministic worldgen (seed -> terrain/rocks/nests/pad)
            ├─ enemy AI, hitscan combat, projectiles, boss
            ├─ stratagems, mission state machine
            └─ snapshots @15 Hz  ── JSON over WebSocket ──┐
                                                          ▼
       clients: input @20 Hz, client-side movement       render + predict
       prediction, snapshot interpolation (120 ms delay)
```

Portable, non-negotiable pieces (live in `shared/` today):

| Concern | File (TS) | Notes for a port |
|---|---|---|
| Tuning constants | `shared/constants.ts` | plain data — port to a C#/C++ struct or data asset |
| Deterministic worldgen | `shared/world.ts` | **bit-exact** integer hashing; see §8 |
| Wire protocol | `shared/protocol.ts` | JSON discriminated by `type`; upgrade path = binary |
| Server sim | `server/src/{sim,room}.ts` | AI, combat, projectiles, mission FSM |

Per-client, free to differ: rendering, animation, camera, audio, UI, input.

---

## 3. Enemy roster

Kind index is what travels on the wire — **append only, never reorder.**

| # | Name | HP | Speed | Dmg | Radius | Role |
|---|------|----|-------|-----|--------|------|
| 0 | Scavenger | 30 | 6.4 | 8 (melee) | 0.55 | fast swarmer, one-shottable |
| 1 | Warrior | 130 | 4.6 | 17 (melee) | 0.85 | bread-and-butter heavy |
| 2 | Spitter | 70 | 3.4 | 18 (acid) | 0.72 | holds range (≈18 m), lobs gravity-arced acid |
| 3 | Charger | 360 | 5.0 | 34 (melee) | 1.15 | telegraphed windup → 3.1× lunge |
| 4 | Titan (boss) | 3200 | 2.3 | 55 / stomp 42 | 3.4 | arrives at 50% quota; stomp AOE + 3-glob bile volley; rewards +8 to the quota |

Spawn mix ramps with mission progress (`spawnWeights`): scavengers thin out,
spitters and chargers ramp up. The titan spawns once per long mission
(killTarget ≥ 12) and is shoved through crowd separation as a heavy.

Behavioral intent (port these *feels*, not just the numbers):
- Scavengers should flank and overwhelm, not queue politely.
- Spitters suppress from range; force the squad to break line of sight.
- Chargers punish standing still — the dive/dodge (roadmap) is the counter.
- The titan is a "stop everything" threat: a moving wall with a healthbar.

---

## 4. Stratagems

Called by punching an arrow code (`U/D/L/R`), then a beacon is thrown where you
aim; it resolves after a short delay. Friendly fire applies to the offensive ones.

You bring a fixed loadout of stratagems (chosen in the lobby, see §7); the
server rejects any you did not bring. Codes are `U/D/L/R` arrow sequences.

| Stratagem | Code | Effect |
|---|---|---|
| Reinforce | ▲▼▶◀▲ | revive downed squadmates (shared budget); always equipped |
| Orbital Strike | ▶▶▲ | one big AOE blast (radius 9, ~420 dmg, falloff) |
| Resupply | ▼▼▲▶ | drops a supply pod (4 charges: refill reserve + heal) |
| Sentry Gun | ▼▲▶▲ | auto-turret: tracks and fires on bugs in range, limited lifetime |
| Napalm Barrage | ▶▶▼▲ | burning area-denial zone (DPS over time, friendly fire) |
| Recon Pulse | ▲▲▼ | pings enemies through the dark — synergizes with the night hook |

**Roadmap stratagems** (designed, not yet built): Shield Bubble (defensive dome).

---

## 5. Mission loop (state machine)

`LOBBY → DROP → KILL → EXTRACT → DEFEND → BOARD → COMPLETE | FAILED → LOBBY`

- **DROP** — hellpods land the squad (≈3 s).
- **KILL** — eradicate a quota (`15 + 10·(players−1)`, then ×difficulty); the
  titan arrives at 50%. (Or, for the **NESTS** objective, seal every bug nest.)
- **EXTRACT** — reach and activate the extraction beacon.
- **DEFEND** — hold the pad until the shuttle arrives (≈75 s, spawn rate up).
- **BOARD** — board before the shuttle leaves (grace ≈18 s).
- **COMPLETE/FAILED** — summary, then reset to LOBBY.

Whole squad down with no reinforcements → FAILED. Reinforce budget is shared:
`4 + 2·(players−1)`.

**Roadmap objective variety:** destroy bug nests (we already place nests),
defend a drilling rig, retrieve & carry data — instead of only a kill quota.

---

## 6. Combat & systems

- **Primary weapons (`WEAPONS`):** five hitscan primaries, each with damage,
  mag/reserve, fire interval, range, reload, cone spread, pellet count and an
  `unlockLevel` (see §7). The shotgun fires multiple pellets, each its own
  hitscan with cone spread; rifles stay tight. The rifle keeps the original
  stats so default behaviour is unchanged. Server fires one hitscan **per
  pellet** and applies per-weapon range. Movement is client-authoritative but
  speed- and collision-checked server-side (PvE: responsiveness over anti-cheat).
- **Projectiles:** server-authoritative acid globs, gravity 9.5, speed 27,
  lead-aimed; carried in snapshots with velocity so clients extrapolate the
  fast arc between the 15 Hz frames.
- **Boss healthbar, charger windup/charging flags, stomp shockwaves, supply
  pods** all flow through the snapshot/event protocol.
- **Netcode rates:** sim 30 Hz, snapshots 15 Hz, client input 20 Hz, remote
  entities rendered 120 ms in the past (interpolation).

---

## 7. Progression & meta

All of this is **server-authoritative** and persisted server-side; clients only
display it. Accounts are keyed by a client-generated id (`pid`) sent on join.

- **Loadout (lobby).** Before a drop each player picks a primary weapon and up
  to 3 stratagems (Reinforce is always equipped). Sent as a `loadout` message;
  ignored mid-mission. The server refuses weapons/stratagems the account hasn't
  unlocked or didn't bring. Persisted client-side (localStorage); re-sent on
  join.
- **XP & levels (`PROGRESSION`, `xpToNext`/`levelForXp`).** Kills (per enemy
  kind), sealed nests and mission completion grant XP; a failed mission still
  banks a fraction of combat XP. XP raises an account level. Accounts start at
  rank 1.
- **Unlocks.** Each weapon has an `unlockLevel`; difficulty tiers unlock with
  rank too. The server validates — the gate can't be bypassed by a client.
- **Persistence.** Profiles are stored in `server/data/profiles.json` (one JSON
  array, debounced atomic writes, flushed on shutdown). `HD_DATA_DIR` overrides
  the location. The `welcome` message returns the account; a post-mission
  `progress` message delivers the XP breakdown, level-ups and new unlocks.
- **Difficulty tiers (`DIFFICULTIES`).** Five tiers (Trivial → Helldive). The
  host picks one in the lobby (`difficulty` message, gated by host rank). Each
  tier is a set of multipliers — enemy cap, spawn rate, enemy HP, enemy damage,
  a heavy-bias on the spawn table, the kill quota and the XP payout. The
  baseline tier (Challenging) is ×1 so the default game is unchanged.
- **Galactic war (`PLANETS`, `GALAXY`).** One persistent, server-wide campaign
  every squad pushes. A completed mission liberates a slice of the active planet
  (scaled by the tier's reward multiplier); at 100% the front advances. Stored
  in `server/data/galaxy.json`; exposed read-only at `GET /galaxy` (so the menu
  can show it before joining) and broadcast as a `galaxy` message after each win.

Wire additions for a port: client→server `loadout`, `difficulty`; server→client
`progress`, `galaxy`; `welcome` now carries `profile` + `galaxy`; `MissionState`
carries `difficulty`; `PlayerState` carries `weapon` + `level`.

---

## 8. The night (atmosphere as identity)

- Dark exponential fog, moonlight + per-soldier flashlights, bloom, ACES,
  film grain, a dead red planet on the horizon, aurora curtains.
- **Lightning storms** (random 9–24 s): a hard flash lights the field; thunder
  follows by a randomized delay. **Rain** falls around the player. A **tension
  drone** swells with the number of enemies within 22 m.
- Procedural texture maps (armor panels, chitin, rock, cape emblem) and glow
  sprites on every light source so it reads at distance through fog.

Future darkness mechanics: limited vision tied to light, light-attracts-enemies,
Recon Pulse to "see" through the dark.

---

## 9. Portability map — bringing this to Unity / Unreal

**What transfers cleanly:** §3–§7 are pure rules (progression/meta included —
it's all server-authoritative data + formulas). The biggest porting risk is
keeping the world **deterministic** so server and every client agree on terrain.

`shared/world.ts` uses 32-bit integer hashing (`mulberry32`, value noise). Port
contract (already documented for the Swift client in `ios/PORTING.md`):

| JavaScript | C# (Unity) | C++ (Unreal) |
|---|---|---|
| `Math.imul(a,b)` | `unchecked((int)a * (int)b)` | `int32 * int32` (wrapping) |
| `x >>> n` | `(uint)x >> n` | `uint32 >> n` |
| `x \| 0`, `^` | cast via `uint`/`int` | `uint32`/`int32` bit ops |
| `/ 4294967296` | `(double)u / 4294967296.0` | same |

**Netcode choice at port time — two options:**
1. **Reuse our Node server.** Engine clients speak the same JSON/WebSocket
   protocol (port `shared/protocol.ts` to C#/C++ types). Keeps one codebase of
   game logic; the engine is "just a renderer." Lowest design risk.
2. **Use the engine's native multiplayer** (Unity Netcode / Unreal replication).
   More idiomatic and lower-latency, but the authoritative sim (§6) must be
   re-implemented in-engine. More work, more divergence risk.

Recommended: keep the Node server (option 1) for the first port so all the
tuning and balance carry over unchanged; migrate to native replication later
only if latency demands it.

**What is throwaway per engine:** rendering, the procedural primitive models
(replaced by the GLB/FBX assets we're already wiring), particle/effect code,
audio synthesis (engines have middleware), input, HUD.

---

## 10. Roadmap (web is the proving ground)

**Done:** new stratagems (Sentry, Napalm, Recon) + dive/dodge roll · objective
variety (destroy nests) · weapons + lobby loadout · XP/levels/unlocks +
account persistence · difficulty tiers · galactic-war meta layer.

**Next:**

1. Darkness mechanics (limited vision, light-attracts-enemies).
2. Real models for the remaining procedural enemies (scavenger, spitter, titan).
3. More objective variety (defend a drill, retrieve & carry data).
4. Ship/loadout depth: stratagem upgrades, armor passives, secondary weapons.
5. Binary snapshots + delta compression past 4 players.
6. **Engine port** (Unity recommended as the pragmatic jump) once the design is
   locked — following this document and `ios/PORTING.md`.
