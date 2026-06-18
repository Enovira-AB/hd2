# Native engine port — plan & verified foundation

Goal: rebuild HELLDIVE in a game engine (native netcode, not the Node server)
to push toward AAA production values, **without throwing away the proven design,
balance and netcode model.** The web build stays the source of truth for design;
this folder is where we de-risk and stage the port.

## Recommended engine: **Unity 6** (with Unreal as the alternative)

You asked me to choose. Given you want to **rebuild the netcode natively** and
were unsure on the engine, Unity is the higher-probability path:

- **Authoritative netcode is far more tractable in Unity.** [Fishnet] (free,
  excellent server-authority model) or Unity's Netcode for GameObjects give you
  a server tick + state replication without writing transport from scratch.
  Unreal's C++ replication + GAS is more powerful but a steep climb when you're
  also learning the engine.
- **C# over C++** for iteration speed and approachability.
- **Cross-platform incl. iOS** (your original goal) is Unity's strength.
- **HDRP** gets you a premium dark-cinematic look — not Unreal's out-of-the-box
  ceiling, but nowhere near "B-tier" for a stylised co-op shooter.

**Pick Unreal 5 instead if** photoreal visuals are the single non-negotiable and
you'll commit to C++/a heavier pipeline (Lumen/Nanite/MetaHuman) — ideally with
dedicated art/graphics help. The plan below is the same either way; only the
language of the ported core changes (C# ⇄ C++), and the worldgen reference here
is already in C++.

## The de-risking split (what makes "rebuild native" feasible)

Rebuilding the authoritative sim from scratch is the biggest-effort option. We
shrink it by separating the **brain** from the **body**:

- **I port the engine-agnostic core to C#** — pure logic, zero engine API:
  deterministic worldgen, all tuning constants, combat math (hitscan, spread,
  damage), enemy AI/steering, the mission state machine, and progression /
  difficulty / galactic-war rules. Each module is verified against a golden
  fixture dumped from the web build.
- **You wire it into Unity** — Fishnet/NGO for the server tick + replication,
  prefabs/GameObjects for rendering, input, camera, HDRP lighting, VFX (VFX
  Graph), audio, and the real art.

So: I hand you the game's brain as portable, tested C#; you give it a body and a
face in the engine.

## What's already here (verified)

- `gen_fixture.ts` → `worldgen_fixture.{json,txt}` — golden outputs from
  `shared/world.ts` (RNG stream, terrain probes, full layouts for 6 seeds). The
  oracle every port is checked against. Regenerate: `npx tsx port/gen_fixture.ts`.
- `worldgen_ref.cpp` — bit-exact C++ port of the world generator, **compiled and
  verified here** against the fixture (RNG exact; positions < 1e-6; rock/nest
  counts identical). Build:
  `g++ -O2 -std=c++17 port/worldgen_ref.cpp -o /tmp/wg && /tmp/wg port/worldgen_fixture.txt`.
  The C# version is a 1:1 translation of this (only syntax differs).

The integer hashing path is **exactly** reproducible across languages; the only
cross-platform variance is sub-1e-6 in cos/sin-derived positions (harmless — the
server stays authoritative on positions). This is the contract in `ios/PORTING.md`.

## Milestones

1. **Foundation** — Unity project + Fishnet; connect; port worldgen + constants
   to C#; regenerate terrain from a seed and verify against the fixture.
2. **Core loop** — port the sim tick (movement, hitscan, enemy steering) into the
   server tick; replicate + render players and bugs. A playable grey-box.
3. **Systems** — mission FSM, stratagems, progression, difficulty, galactic war
   (port my existing logic; same balance numbers).
4. **Visual pass (the AAA layer)** — HDRP, the night lighting identity, real
   models/animations, VFX, audio. Where the production value lives.
5. **Platforms** — PC build, then iOS.

## Division of labour

| I can do (here, autonomously) | You do (needs the engine GUI / assets) |
|---|---|
| Port the core to C# module by module, each fixture-verified | Install Unity 6 + Fishnet; create the project |
| Generate golden fixtures from the web build for any system | Import the scripts; wire prefabs, camera, input |
| Write the Unity integration guide (where each script goes) | Build the HDRP look, lighting, VFX, audio |
| Prep server/deploy config if you keep any backend | Acquire real AAA art (Megascans, Asset Store, commissioned) |
| Keep the web build as the design source of truth | Run/iterate the editor; build & ship to platforms |

[Fishnet]: https://fish-networking.gitbook.io/docs/
