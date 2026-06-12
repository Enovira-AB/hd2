# HELLDIVE — native iOS client (SceneKit + SwiftUI)

A native Swift client for the same authoritative server the web client uses.
No webview, no Capacitor — SceneKit rendering, URLSessionWebSocketTask
networking, and a bit-exact Swift port of the shared world generator.

> **Status: milestone 1 scaffold.** Written against iOS 17 APIs but not yet
> compiled — this repo's CI environment has no Xcode. Expect to fix a handful
> of compiler nits on first build. Networking, protocol, world generation and
> the render/interpolation loop are complete; effects/stratagem UI/audio are
> marked TODO in `GameScene.swift`.

## Build

Requirements: a Mac with Xcode 16+, iOS 17+ device or simulator.

```bash
brew install xcodegen
cd ios
xcodegen            # generates Helldive.xcodeproj from project.yml
open Helldive.xcodeproj
```

Set your signing team in *Targets → Helldive → Signing & Capabilities*, then run.

## Connect to your server

1. Start the server on your Mac: `npm run dev` (or `npm run build && npm start`) in the repo root.
2. In the app's menu, set **SERVER URL** to your Mac's LAN address, e.g.
   `http://192.168.1.50:8080` (the app upgrades it to `ws://…/ws` itself).
3. Web players and iOS players join the same squads with the same codes.

`NSAllowsArbitraryLoads` is enabled for LAN development. For TestFlight or the
App Store, host the server behind TLS and use `https://` (→ `wss://`), then
remove that exception from `project.yml`.

## File map

| File | Purpose | Mirrors |
|---|---|---|
| `Protocol.swift` | message types, decode by `type` | `shared/protocol.ts` |
| `Constants.swift` | client-relevant tuning | `shared/constants.ts` |
| `WorldGen.swift` | seed → terrain/rocks/pad/nests | `shared/world.ts` |
| `NetClient.swift` | WebSocket, clock sync, interpolation | `web/src/net.ts` |
| `GameScene.swift` | SceneKit world + local player + views | `web/src/world3d.ts` + `game.ts` |
| `HelldiveApp.swift` | menu/lobby/HUD/touch controls | `web/src/main.ts` + `hud.ts` |

See `PORTING.md` for the determinism contract — read it before touching
`WorldGen.swift`.
