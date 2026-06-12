# Drop-in 3D models

Put GLB files here and the game uses them instead of the procedural
primitives — no code changes, no rebuild needed in dev. Missing files fall
back to procedural automatically.

| File | Replaces | Normalized to |
|---|---|---|
| `soldier.glb` | all helldivers | 1.95 m tall |
| `bug0.glb` | scavenger (small bug) | 0.95 m |
| `bug1.glb` | warrior (big bug) | 1.55 m |

## Requirements

- **GLB** (binary glTF), facing **+Z** (the glTF standard forward).
- Models are auto-scaled to the heights above and grounded at y=0 —
  any source scale works.
- Skeletal animation clips are matched by name (case-insensitive):
  `Run` or `Walk` → moving · `Idle` → standing · `Death`/`Die` → death.
  Models without clips render statically (fine for crates, bad for bugs).
- If a node is named `muzzle`/`barrel`/`gun`/`weapon`, tracers originate
  from it; otherwise a sensible offset is used.

Check the browser console: `[models] /models/soldier.glb loaded (clips: …)`
tells you what was found.

## Instant test asset (animated soldier)

The three.js example soldier has `Idle/Run/Walk` clips and drops straight in:

```bash
curl -L -o web/public/models/soldier.glb \
  https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb
```

That model is a Mixamo character shipped with the three.js examples — fine
for prototyping; swap it for a properly licensed asset before any release.

## Where to get good free assets

- **kenney.nl/assets** — CC0, huge sci-fi selection
- **quaternius.com** — CC0, low-poly animated characters & monsters
- **poly.pizza** — searchable aggregator of CC0/CC-BY models

CC0 needs no attribution (credit is still kind). For CC-BY, add the credit to
the main README. GLBs you put here get committed and shipped with the Docker
image — keep an eye on file sizes; a few MB per model is fine.
