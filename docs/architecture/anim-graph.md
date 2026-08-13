# Animation graph (P9)

Worker-side state machine that drives glTF `Animation` clips and Sprite named clips (engineplan §12). New package `@babylonslate/anim-graph`: no React, no Babylon — the evaluator runs in the game worker.

`render` seeks `AnimationGroup` / sprite clip UVs from snapshot (or command) fields and **never** lets Babylon auto-advance gameplay animation ([engineplan §2.3](../engineplan.md)).

## Evaluator

Pure function: `(graph, dt, inputs, rng) → { stateId, normalisedTime, blendWeights }`. Deterministic; golden-tested. Validator uses the same diagnostic model as [scripting.md](scripting.md) (`code`, `message`, `nodeId`, severity).

Snapshot / command payload per actor: current state id, normalised time in `[0, 1]`, blend weights, plus `clipName` / `clipKind` so render can seek without holding the graph. Protocol: extra command-channel `animState` messages (not a snapshot stride bump) so existing 16-float actor slots stay valid. See [bridge.md](bridge.md).

`AnimationGraphComponent` (`graphGuid`) attaches a graph to an actor. `RuntimeDriver.registerAnimGraph` / worker `loadAnimGraphs` load documents; each tick `evaluateAnimGraph` runs in the game worker and emits `animState`. Play posts `loadAnimGraphs` for **open** AnimationGraph documents (same pattern as open scene / scripts). Scanning the whole registry at Play start is later polish. Render `seekGameplayAnimation` pauses the `AnimationGroup` and `goToFrame`s; sprite clips use `applySpriteAnimFrame` via `applyAnimStateToScene` when `clipKind === "sprite"` and `createEngine` is given `spritePayloads` keyed by the `assignMesh` guid. Babylon never auto-advances gameplay animation.

Drives:

- glTF `Animation` assets already imported by the model importer.
- Sprite named clips from [sprites.md](sprites.md).

## Authoring

`GraphEditor` from `graph-ui` with a small node-type map (states, transitions, blend). Own validator; diagnostics navigate like script graphs.
