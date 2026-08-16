# Animation graph (P9)

Worker-side state machine plus per-instance Animation Object graphs that drive glTF `AnimationGroup` clips and Sprite named clips (engineplan §12). Package `@babylonslate/anim-graph`: no React, no Babylon — the evaluator runs in the game worker.

`render` seeks `AnimationGroup` / sprite clip UVs from `animState` and **never** lets Babylon auto-advance gameplay animation ([engineplan §2.3](../engineplan.md)).

## Document (schema v2)

`ANIM_GRAPH_SCHEMA_VERSION = 2`. Parse migrates v1 (`parameters` → bool variables; `condition` / `hasExitTime` → Exit State wiring).

| Field | Role |
| --- | --- |
| `states` / `entryStateId` / `clips` | FSM. Clip kind is `animation` (glTF group name) or `sprite` (named sprite clip). |
| `variables[]` | Typed graph-owned store (`bool` / `int` / `float` / `string`). Bool names stay mirrored on legacy `parameters`. |
| `animationObject` | Serialized scripting graph. Default seeds protected `Event Initialize Animation` and `Event Update Animation`. |
| `transitions[]` | `blendSeconds`, `priority` (lower wins), `ruleGraph`. Legacy `condition` / `hasExitTime` remain as evaluator fallback. |

Helpers: `createDefaultAnimGraph`, `createDefaultAnimationObjectGraph`, `createDefaultTransitionRuleGraph` (protected Enter State / Exit State bool sinks). Class ids: `animGraphScriptClassId(guid)` → `AnimGraph:{guid}`; `animRuleScriptClassId(guid, transitionId)` → `AnimRule:{guid}:{transitionId}`.

## Evaluator

Pure function: `(graph, dt, previous, inputs) → AnimEvalState`. Deterministic; golden-tested. Validator uses the same diagnostic model as [scripting.md](scripting.md) (`code`, `message`, `nodeId`, severity).

Each tick produces `stateId`, `normalisedTime` in `[0, 1]`, `blendWeights`, `facts` (elapsed / duration / remaining / looping / loop count / one-tick `justLooped` / `justFinished`), and weighted `layers[]` (`clipAssetGuid`, `clipName`, `clipKind`, `normalisedTime`, `weight`). `blendSeconds` crossfades two layers.

Transition fire: **Exit State** (leave source) **and** **Enter State** (enter target) must both be true. Disconnected sinks default **true**. `decideTransition(transition, facts)` sees **post-advance** facts. `undefined` falls through to `transitionRules`, then legacy `condition` / `hasExitTime`. A v2 transition with no compiled decision and no legacy condition still always passes.

## Runtime

`AnimationGraphComponent` (`graphGuid`) attaches a graph to an actor. `RuntimeDriver.registerAnimGraph` / worker `loadAnimGraphs` load documents. Play loads graphs referenced by scene `graphGuid` plus every project AnimationGraph (Compile / Play / export).

Each tick `tickAnimGraphs`:

1. Seed component `variableStore` from document defaults.
2. Once per `${slotId}:{guid}`, `invokeAnimEvent(AnimGraph:{guid}, onInitializeAnimation)`.
3. Every tick, `invokeAnimEvent(..., onUpdateAnimation, dt)`.
4. `evaluateAnimGraph` with `decideTransition` → `invokeAnimRule(AnimRule:{guid}:{id})` (`exports.evaluate` → `{ enter, exit }`; missing class / throw → `undefined` = legacy fallback).

`self` on those scripts is the **Actor**. Get/Set Variable hit the component `variableStore` when the host passes it. Animation Object Get Variable nodes migrate with `implicitSelf: true`.

Protocol: extra command-channel `animState` (not a snapshot stride bump). See [bridge.md](bridge.md).

Drives:

- glTF `Animation` assets already imported by the model importer (seek registered `AnimationGroup`s).
- Sprite named clips from [sprites.md](sprites.md).

## Render

`applyAnimStateToScene` applies **all** weighted `layers[]` (or synthesizes one from `clipName`). Lookup is per-slot: `getAnimationGroup(slotId, clipName, clipAssetGuid)`, then `scene.animationGroups`. Missing clip → `onMissingClip` (create-engine skips the warn when no groups are registered yet). Sprite two-layer blend: base mesh + overlay; visibilities = weights. Overlay is created in `createPlayMesh` when a sprite frame exists and disposed with the slot. Pending `animState` is replayed after `assignMesh`.

GLB `createMeshFromModelBytes` still builds the first primitive synchronously; skeletal `AnimationGroup`s play when they are on `scene.animationGroups` or `slotAnimationGroups`. Async AssetContainer extract is not wired.

## Compile / Play / export

`compileAnimGraphScripts([{ guid, path, document }])` emits `AnimGraph:{guid}` (Animation Object → `onInitializeAnimation` / `onUpdateAnimation`) and one `AnimRule:{guid}:{transitionId}` per transition (`export function evaluate(ctx)`). `parentClassId: "BObject"`. Failures log and skip that asset. `spawnListForScripts` only spawns `onBeginPlay` / `onTick`, so these classes do not spawn extra actors.

Play `collectPlayPreviewScripts` and export `collectAndExportGame` merge those bundles with Class/UI scripts. The packaged player hydrates `loadAnimGraphs` before `play` ([exporter.md](exporter.md)).

## Authoring

DockView document (`DockviewShell`, kind `anim-graph`), not `AssetDocumentWorkspace`. Chrome **State Machine | Animation Object** `AnimEditorModeBar` (`ToggleGroup`) sits **outside** DockView — same pattern as UserInterface **Designer | Logic**. `documentKind` stays `"anim-graph"`; modes use `animEditorMode` and DockView surfaces `stateMachine` / `animationObject`. `layout.json` stores `{ animEditorMode, stateMachine, animationObject }`; a raw old snapshot migrates to State Machine.

| Mode | Catalog (Windows / Focus) | Primary |
| --- | --- | --- |
| State Machine | Graph, Variables, Details, Compiler Results | `anim-graph-graph` |
| Animation Object | Graph, Variables, Inspector, Compiler Results | `anim-object-graph` |

Engine Settings Focus keep-lists: **Animation Graph State Machine** (`anim-graph` → Graph) and **Animation Graph Object** (`animGraphObject` → `anim-object-graph`).

### State Machine

- **Variables** (left) — typed name + type enum, **Add Variable** (`anim-graph-add-variable`), plus a States list and **Add State**. Keeps `data-testid="anim-graph-parameters"` for existing e2e.
- **Graph** (primary) — `GraphEditor` with `animGraphNodeTypes` / `animGraphEdgeTypes`, `defaultEdgeOptions` type `animTransition`. Unreal-style rounded state nodes (Entry mark) and CSS-triangle transition badges (no lucide). Double-click a badge (or Details **Open Rule**) opens a nested rule graph: breadcrumb `State Machine > Source To Target`, undeletable Enter/Exit sinks. Palette: `scriptPaletteNodes(..., { animationGraphHost: "rule" })` — `anim.state.*` queries, pure math/bool, Get Variable; no events, no Set Variable, no `debug.log`.
- **Details** (right) — selected state (name, entry, clip kind, Animation/Sprite `AssetPicker`, clip name, speed, loop) and outgoing `blendSeconds` / `priority` / Open Rule. Condition / hasExitTime / exit-time rows live in the rule graph, not Details.

`AnimState.position` round-trips through `animGraphToSerialized` / `serializedToAnimGraph`. Transition blend / priority / `ruleGraph` merge when canvas edge ids change.

### Animation Object

Reuses Class **Graph** / **Inspector** panels (`GraphPanel`, `InspectorPanel`) with `parentClass` BObject and `animationGraphHost: "object"`. Palette: `anim.event.*` plus runtime-safe nodes; hides rule/state queries, Begin Play, BT. Variables panel is the same typed list without States. `serializedGraphFromDocument("anim-graph")` returns `animationObject` with injected `members` from `variables`. Commits write `{ nodes, edges }` without dropping states (`commit.kind === "anim-graph"`). Open AnimationGraph tabs are skipped by `collectClassGraphsForPalette` so they are not treated as Class palettes.

### Palettes and protected nodes

`ClassEventOptions.animationGraphHost?: "object" | "rule"`. Actor palettes hide all `anim.*`. `PROTECTED_NODE_TYPES` includes `anim.event.initialize` / `update` and `anim.rule.enterState` / `exitState`. `nodeVisualRole` paints those as events.

### Diagnostics

State Machine publishes `validateAnimGraph` (plus nested `validateSerializedGraph` when a rule is open) only while `animEditorMode === "stateMachine"`. GraphPanel publishes Animation Object diagnostics only while `animEditorMode === "animationObject"`.

Shared selection lives in `AnimGraphEditingProvider`. Focus defaults to the active mode’s Graph panel.
