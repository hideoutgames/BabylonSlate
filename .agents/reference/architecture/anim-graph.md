# Animation Graph

Worker-side animation state machine plus per-instance Animation Object graphs that drive glTF Animation clips and Sprite Animation assets.

## Invariants

- `@babylonslate/anim-graph` has no React and no Babylon; the evaluator runs in the game worker.
- Render seeks `AnimationGroup`s and sprite frames from `animState` and never lets Babylon auto-advance gameplay animation. Groups stay paused with live animatables (`play()` then `pause()`); never `stop()`, which empties animatables and makes `goToFrame` a no-op.
- `animState` is an extra command-channel message ([bridge.md](bridge.md)), not a snapshot stride change. One `animState` per actor slot: the last graph in component order wins playback.
- Behaviour Tree Play Animation emits the same `animState`; there is no second playback clock.
- Treat evaluated documents as immutable: derived lookups are cached per document object, so replace a document instead of mutating it.

## Ownership

| Area | Source |
| --- | --- |
| Schema, evaluator, `animExitTimeReached`, validation, `resolveAnimGraphClips` | [`packages/anim-graph/src/graph.ts`](../../../packages/anim-graph/src/graph.ts) |
| Editor serialization | [`packages/anim-graph/src/serialize.ts`](../../../packages/anim-graph/src/serialize.ts) |
| Runtime host (`AnimGraphRuntime.tick`) | [`packages/runtime/src/anim-graph-runtime.ts`](../../../packages/runtime/src/anim-graph-runtime.ts) |
| Scene apply (`applyAnimStateToScene`, sprite frames) | [`packages/render/src/anim-apply.ts`](../../../packages/render/src/anim-apply.ts) |
| Model material slots | [`packages/render/src/model-preview.ts`](../../../packages/render/src/model-preview.ts) |
| Compile (`compileAnimGraphScripts`) | [`apps/editor/src/services/script-compiler.ts`](../../../apps/editor/src/services/script-compiler.ts) |
| Editor document, mode bar, provider | [`apps/editor/src/components/document-workspace.tsx`](../../../apps/editor/src/components/document-workspace.tsx), [`apps/editor/src/context/anim-graph-editing-context.tsx`](../../../apps/editor/src/context/anim-graph-editing-context.tsx), [`apps/editor/src/shell/window-catalog.ts`](../../../apps/editor/src/shell/window-catalog.ts) |

## Document format

- `ANIM_GRAPH_SCHEMA_VERSION = 2`; parse reads only v2. Fields: `states`, `entryStateId`, `clips`, typed `variables[]` (bool / int / float / string / tag / Tag Container), `animationObject` (a scripting graph seeded with protected Event Initialize / Update Animation), `transitions[]` (`blendSeconds`, `priority` — lower wins, `ruleGraph`, side handles).
- Clip kind `animation` = Animation asset guid + glTF `AnimationGroup` name; kind `sprite` = Sprite Animation guid (no clip name).
- Compiled class ids: `AnimGraph:{guid}` (Animation Object) and `AnimRule:{guid}:{transitionId}` (`export function evaluate(ctx)` → `{ enter, exit }`), both `parentClassId: "BObject"`. Loading compiled scripts never instantiates actors.
- `AnimState.position` and editor-only `clipLabel` are presentation data; `__disabled` on One Way rules is canvas-only and stripped on persist.

## Evaluator

- Pure `(graph, dt, previous, inputs) → AnimEvalState`, deterministic and golden-tested. Output: `stateId`, `normalisedTime`, `blendWeights`, timing `facts`, weighted `layers[]`.
- A transition fires when both Exit State and Enter State are true; unwired sinks default true. `decideTransition` sees post-advance facts; `undefined` (missing class or throw) passes. An infinite-loop abort is rethrown.
- Blend length is captured when the blend starts so a duplicate `(from, to)` row cannot change it mid-blend.
- Exit Time Reached fires on crossing (Unity-style), once per loop for `exitTime ≤ 1`, once for `exitTime > 1`; non-looping states use a level test. Plain `normalisedTime` is post-wrap; use Exit Time Reached for end-of-loop thresholds.
- Missing entry state starts on the first state; transitions to missing states never fire. Nothing throws.

## Runtime

- `AnimationGraphComponent.graphGuid` attaches a graph. `AnimGraphRuntime.tick` visits only owners from the shared component owner index ([object-model.md](object-model.md)).
- Per component: seed its own copy of variable defaults → Initialize once per `componentGuid:graphGuid` → Update every tick → evaluate → set or clear the actor sprite clip.
- Evaluation and pending Jump To State belong to one graph guid; switching graphs restarts at the entry state. Jumps apply on the next `tickAnimGraphs`, so Actor `onTick` cannot race the evaluator.
- `self` in Animation Object scripts is the Actor. Actor Class graphs use `anim.actor.*` nodes with a required `AnimationGraphComponent` target; unwired targets are no-ops.
- Play/export load only Animation Graphs in the session dependency closure; editor Compile compiles every project graph.
- Trace frames record per-component evaluation, graph guid and pending jump; restore does not re-run On Initialize Animation.

## Render rules

- Clip lookup is per slot (`getAnimationGroups(slotId)`); never seek another actor's same-name group. With `clipAssetGuid` set, untagged groups do not match.
- Each Model is loaded once per Scene; actors instance under a `__importScale` child of an empty named root (`editorActor:<id>` / `actor-N`) so import scale never overwrites snapshot TRS.
- Material slots map by glTF material index, then construction name, then unused index — not child visit order. `MeshComponent.materialGuid` overrides the whole visual.
- `resolveAnimGraphClips` keeps Animation guids (never rewrites Animation → Model). Retargeted Animations load the source Model GLB and retarget at rest pose.
- `anim.skeletonMismatch` is an error when an Animation's skeleton differs from the owning Model's.

## Editor rules

- DockView document kind `anim-graph`. The **State Machine | Animation Object** `AnimEditorModeBar` sits outside DockView; each mode has its own DockView surface, Windows list and Focus keep-list, persisted as `layout.json` `{ animEditorMode, stateMachine, animationObject }`. Only the active mode stays mounted.
- Rule palettes (`animationGraphHost: "rule"`) allow `anim.state.*`, pure nodes and Get Variable only; Object palettes (`"object"`) add `anim.event.*`; Actor palettes hide both and show `anim.actor.*`. Protected nodes: initialize/update events and Enter/Exit sinks.
- One directed `(from, to)` pair is one visual edge; Both Ways is two rows drawn as one edge. Extra rows warn `anim.duplicateTransition`.
- State names must be non-empty and unique (trimmed, case-insensitive). Diagnostics publish only for the active mode.
- Renaming or retyping a variable rewrites bound Get/Set nodes in `animationObject` and every rule graph.
