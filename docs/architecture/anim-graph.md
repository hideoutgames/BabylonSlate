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

Asset-document host (`AnimGraphEditor`), not a Dockview Class layout. Three columns:

- **Parameters** — `NamedListEditor` on `doc.parameters` (bool/trigger names the worker reads as `inputs.conditions`).
- **States** — list plus **Add State**; double-tap canvas still opens Add Node (`anim.state`).
- **Graph** — `GraphEditor` with `hydrateAnimGraphForEditor` / `animPaletteNodes()` `in` / `out` pins so wires are connectable.
- **Details** — selected state (name, entry, clip kind, Animation/Sprite `AssetPicker`, clip name, speed, loop) and outgoing transitions (condition, blend seconds, exit time).

`AnimState.position` round-trips through `animGraphToSerialized` / `serializedToAnimGraph` so drags stick. Transition condition / blend / exit-time merge from the previous document when canvas edge ids change. Own validator; diagnostics navigate like script graphs.

