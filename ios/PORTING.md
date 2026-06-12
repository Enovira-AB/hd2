# Porting contract: shared logic across TypeScript and Swift

The game has exactly one authoritative simulation (the Node server). Clients
render and predict. Two things must nevertheless be **bit-identical** across
every language the game is ported to:

## 1. World generation (`shared/world.ts` ⇄ `WorldGen.swift`)

The server never sends terrain. Clients regenerate it from `mission.seed`, so
the hash/noise pipeline must match exactly — a one-bit difference puts players
inside rocks on one platform and on top of them on another.

JS bitwise semantics → Swift:

| JavaScript | Swift | Notes |
|---|---|---|
| `Math.imul(a, b)` | `Int32(bitPattern: a) &* Int32(bitPattern: b)` | 32-bit wrapping signed multiply |
| `x >>> n` | `UInt32 >> n` | logical shift; JS coerces to uint32 first |
| `x \| 0`, `x ^ y` | `Int32`/`UInt32` with `bitPattern:` | JS coerces via ToInt32 |
| `(x + y) ^ z` where x+y is float | `x &+ y` then `^` | ToInt32 is mod 2³², same as wrapping add |
| `/ 4294967296` | `Double(u) / 4294967296.0` | uint32 → [0, 1) |

The verification oracle: `scripts/playthrough.mjs` re-implements `mulberry32`
and `padPosition` from scratch and walks to the computed pad — if the server
accepts the extraction interaction there, the derivation matches. Do the same
when validating the Swift port: print `padPosition(seed:)` for a live room's
seed and compare with the web client's debug output.

The RNG **call order matters**: `generateLayout` must consume random numbers
in exactly the order the TS version does (rocks loop with its rejects, then
nests loop). Never reorder, never early-return differently.

## 2. The wire protocol (`shared/protocol.ts` ⇄ `Protocol.swift`)

- JSON, discriminated by `"type"`.
- Unknown message types must be ignored (forward compatibility) — the Swift
  decoder maps them to `.unknown`.
- `join` carries `v` (protocol version); the server rejects mismatches, so bump
  `K.protocolVersion` together with `PROTOCOL_VERSION` in `shared/constants.ts`.
- Positions are `[x, y, z]` meter arrays; yaw is `atan2(dx, dz)` radians
  (0 faces +Z); times are server epoch milliseconds. Convert with the clock
  offset from `pong` (see `NetClient.serverNow()`), never with the device clock.

## 3. What is deliberately NOT shared

Movement feel (acceleration smoothing), camera, effects, audio and UI are
per-client and free to differ. The server validates positions only against
max speed and collisions, so clients cannot disagree in ways that matter
competitively.
