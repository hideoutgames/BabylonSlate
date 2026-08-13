# Animation graph (P9)

Worker-side state machine that drives glTF `Animation` clips and Sprite named clips (engineplan §12). New package `@babylonslate/anim-graph`: no React, no Babylon — the evaluator runs in the game worker.

`render` seeks `AnimationGroup` / sprite clip UVs from snapshot (or command) fields and **never** lets Babylon auto-advance gameplay animation ([engineplan §2.3](../engineplan.md)).

## Evaluator

Pure function: `(graph, dt, inputs, rng) → { stateId, normalisedTime, blendWeights }`. Deterministic; golden-tested. Validator uses the same diagnostic model as [scripting.md](scripting.md) (`code`, `message`, `nodeId`, severity).

Snapshot / command payload per actor: current state id, normalised time in `[0, 1]`, blend weights, plus `clipName` / `clipKind` so render can seek without holding the graph. Protocol: extra command-channel `animState` messages (not a snapshot stride bump) so existing 16-float actor slots stay valid. See [bridge.md](bridge.md).

`AnimationGraphComponent` (`graphGuid`) attaches a graph to an actor. `RuntimeDriver.registerAnimGraph` / worker `loadAnimGraphs` load documents; each tick `evaluateAnimGraph` runs in the game worker and emits `animState`. Play loads graphs referenced by scene `AnimationGraphComponent.graphGuid` (plus any open AnimationGraph tabs). Render `seekGameplayAnimation` pauses the `AnimationGroup` and `goToFrame`s; sprite clips use `applySpriteAnimFrame` via `applyAnimStateToScene` when `clipKind === "sprite"` and `createEngine` is given `spritePayloads` from scene `SpriteComponent` guids. Babylon never auto-advances gameplay animation.

Drives:

- glTF `Animation` assets already imported by the model importer.
- Sprite named clips from [sprites.md](sprites.md).

## Authoring

`GraphEditor` from `graph-ui` with a small node-type map (states, transitions). `hydrateAnimGraphForEditor` / `animPaletteNodes()` inject `in` / `out` pins on `anim.state` so Add Node is connectable. Own validator; diagnostics navigate like script graphs. Blend / exit-time inspector stays parked — the Play evaluator already consumes those fields when present.
