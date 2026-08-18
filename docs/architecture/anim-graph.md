# Animation graph (P9)

Worker-side state machine plus per-instance Animation Object graphs that drive glTF `AnimationGroup` clips and **Sprite Animation** assets (engineplan §13.2). Package `@babylonslate/anim-graph`: no React, no Babylon — the evaluator runs in the game worker.

`render` seeks `AnimationGroup` / sprite frames from `animState` and **never** lets Babylon auto-advance gameplay animation ([engineplan §2.3](../engineplan.md)).

## Document (schema v2)

`ANIM_GRAPH_SCHEMA_VERSION = 2`. Parse migrates v1 (`parameters` → bool variables; `condition` / `hasExitTime` → Exit State wiring).

| Field | Role |
| --- | --- |
| `states` / `entryStateId` / `clips` | FSM. Clip kind is `animation` (Model guid + glTF `AnimationGroup` name) or `sprite` (**Sprite Animation** guid; Clip Name hidden). Legacy Sprite guid + clip name still resolves via `spriteClipFrameAt`. |
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
5. If the current clip is `kind: "sprite"` with an asset guid, `setActorSpriteClip`; otherwise clear it so a later Model state does not keep the last Sprite Animation box.

`self` on those scripts is the **Actor**. Get/Set Variable hit the component `variableStore` when the host passes it. Animation Object Get Variable nodes migrate with `implicitSelf: true`.

**Actor Class graphs** may use `anim.actor.*` (`Set` / `Get` graph variable, `Get Current State`, `Jump To State`) targeting `AnimationGraphComponent` on `self`. `anim.event.*` / `anim.rule.*` / `anim.state.*` stay gated to Animation Object / rule hosts. Jump is pending until the next `tickAnimGraphs` so Actor `onTick` (inside `world.tick()`) cannot race the evaluator.

Protocol: extra command-channel `animState` (not a snapshot stride bump). See [bridge.md](bridge.md).

Drives:

- glTF `Animation` clips via `@babylonjs/loaders` `LoadAssetContainerAsync` (Play `modelBytes` → paused per-slot `AnimationGroup`s).
- Sprite Animation assets (and legacy Sprite named clips) from [sprites.md](sprites.md). `applySpriteAnimationAssetFrame` binds the current frame Texture, full UVs, pixel size, and pivot on the `SpriteComponent` quad. Duration for the evaluator is the sum of **effective** frame durations (`frameDurationMs`, or per-frame `durationMs` when `durationMsOverride` is true).

## Render

`applyAnimStateToScene` applies **all** weighted `layers[]` (or synthesizes one from `clipName`). Lookup is per-slot: `getAnimationGroup(slotId, clipName, clipAssetGuid)`, then `scene.animationGroups`. When `clipAssetGuid` is set, name-only / untagged groups do not match — two slots can both play `"Idle"` from different Models. Missing clip → `onMissingClip` (create-engine skips the warn when no groups are registered yet). Sprite two-layer blend: base mesh + overlay; visibilities = weights. Overlay is created in `createPlayMesh` when a sprite frame exists and disposed with the slot. Pending `animState` is replayed after `assignMesh` and after GLB groups land.

GLB `createMeshFromModelBytes` still builds the first primitive synchronously so the actor appears immediately. When the GLB lists animations, `beginSlotModelAnimLoad` extracts `AnimationGroup`s with `LoadAssetContainerAsync`. The Play slot mesh stays the **transform root**: `addAllToScene`, then `adoptLoadedHierarchy` parents every parentless container node (`rootNodes`, `transformNodes`, and `meshes` — including glTF `__root__`, which may be a Mesh or a TransformNode) under that placeholder. Nodes that already have a parent stay in the loaded skeleton. Placeholder geometry is hidden (`visibility = 0`); do not dispose the slot or promote the first `Mesh`. Snapshot TRS on the slot therefore moves the whole glTF. Groups are paused (Babylon must not auto-advance gameplay clips), stamped with the **Model** guid, and the last `animState` is replayed.

## Compile / Play / export

`compileAnimGraphScripts([{ guid, path, document }])` emits `AnimGraph:{guid}` (Animation Object → `onInitializeAnimation` / `onUpdateAnimation`) and one `AnimRule:{guid}:{transitionId}` per transition (`export function evaluate(ctx)`). `parentClassId: "BObject"`. Failures log and skip that asset. `spawnListForScripts` only spawns `onBeginPlay` / `onTick`, so these classes do not spawn extra actors.

Play `collectPlayPreviewScripts` and export `collectAndExportGame` merge those bundles with Class/UI scripts. The packaged player hydrates `loadAnimGraphs` and `loadSprites` (Sprite + Sprite Animation payloads) before `play` ([exporter.md](exporter.md)). Editor Play parses graphs then `resolveAnimGraphClips` so worker layers carry the Model guid + glTF group name, or a Sprite Animation guid + summed `durationMs`. Play collects Sprite Animation payloads referenced by **loaded graphs** (not only open tabs), plus their Textures.

## Authoring

DockView document (`DockviewShell`, kind `anim-graph`), not `AssetDocumentWorkspace`. Chrome **State Machine | Animation Object** `AnimEditorModeBar` (`ToggleGroup`) sits **outside** DockView — same pattern as UserInterface **Designer | Logic**. `documentKind` stays `"anim-graph"`; modes use `animEditorMode` and DockView surfaces `stateMachine` / `animationObject`. `layout.json` stores `{ animEditorMode, stateMachine, animationObject }`; a raw old snapshot migrates to State Machine. Mode switches keep only the active DockView mounted. Idle-unmount of inactive document tabs is **P17** (`p17-inactive-documents`).

| Mode | Catalog (Windows / Focus) | Primary |
| --- | --- | --- |
| State Machine | Graph, Variables, Details, Compiler Results | `anim-graph-graph` |
| Animation Object | Graph, Variables, Inspector, Compiler Results | `anim-object-graph` |

Engine Settings Focus keep-lists: **Animation Graph State Machine** (`anim-graph` → Graph) and **Animation Graph Object** (`animGraphObject` → `anim-object-graph`).

### State Machine

- **Variables** (left) — compact `--chrome-row` (28px) name `Input` + type `Select` `size="sm"` and trash `IconActionButton`. **Add Variable** / **Add State** use `Button` `size="sm"` (not 44px touch). States are a compact selected list (`bg-primary/20` + ink bar). Keeps `data-testid="anim-graph-parameters"` for existing e2e. Selecting a state from the list or canvas updates Details **without** `fitView` / `focusedNodeId`; only compiler diagnostics / Frame zoom.
- **Graph** (primary) — `GraphEditor` with `animGraphNodeTypes` / `animGraphEdgeTypes`, `defaultEdgeOptions` type `animTransition`, `connectEndMode="zone-add-node"` (far empty-canvas release opens Add State; near-pin tap/release and a second pointer cancel without breaking transitions). Unreal-style rounded state nodes (`min-width: 200px`, `min-height: 88px`) with **four thin side handles** (~16px plates, geometric ticks; the body is the 44px move target). Directed `MarkerType.ArrowClosed` paths; **Both Ways** is two `AnimTransition` rows that render as one visual edge with arrows on both ends. CSS-triangle blend badges rotate with the edge tangent. Single-click a badge selects the edge (Details). Double-click (or Details **Open Rule**) opens a nested rule graph: breadcrumb `State Machine > Source To Target`, undeletable Enter/Exit sinks. Palette: `scriptPaletteNodes(..., { animationGraphHost: "rule" })` — `anim.state.*` queries, pure math/bool, Get Variable; no events, no Set Variable, no `debug.log`. A palette pick from a dangling wire auto-connects the **opposite** side (`right-out` → `left-in`).
- **Details** (right) — selected state (name, entry, **Clip Kind**, **Clip Asset**, **Clip Name**, speed, loop) and outgoing **Blend Seconds** / **Priority** / **Direction** (`One Way` | `Both Ways`) / Open Rule. Clip Kind **Animation**: Clip Asset is Models only; Clip Name is a `SearchDropdown` of Model `payload.clipNames` (never a type-in). Empty catalog shows disabled **No Clips**. Clip Kind **Sprite**: Clip Asset is **Sprite Animation** only; Clip Name is hidden. `kind: "animation"` `assetGuid` is the Model Play loads (`modelBytes`), not a Content Browser Animation row. `resolveAnimGraphClips` rewrites legacy Animation guids to the owning Model (`Model.dependencies`) and fills Sprite Animation `durationMs`. Importers store Model `clipNames` on the header payload.

`AnimState.position` round-trips through `animGraphToSerialized` / `serializedToAnimGraph`. Transition blend / priority / `ruleGraph` merge when canvas edge ids change.

### Animation Object

Reuses Class **Graph** / **Inspector** panels (`GraphPanel`, `InspectorPanel`) with `parentClass` BObject and `animationGraphHost: "object"`. Palette: `anim.event.*` plus runtime-safe nodes; hides rule/state queries, Begin Play, BT. Variables panel is the same typed list without States. `serializedGraphFromDocument("anim-graph")` returns `animationObject` with injected `members` from `variables`. Commits write `{ nodes, edges }` without dropping states (`commit.kind === "anim-graph"`). Open AnimationGraph tabs are skipped by `collectClassGraphsForPalette` so they are not treated as Class palettes.

### Palettes and protected nodes

`ClassEventOptions.animationGraphHost?: "object" | "rule"`. Actor palettes hide `anim.event.*` / `anim.rule.*` / `anim.state.*` and show `anim.actor.*`. `PROTECTED_NODE_TYPES` includes `anim.event.initialize` / `update` and `anim.rule.enterState` / `exitState`. `nodeVisualRole` paints those as events.

### Diagnostics

State Machine publishes `validateAnimGraph` (plus nested `validateSerializedGraph` when a rule is open) only while `animEditorMode === "stateMachine"`. GraphPanel publishes Animation Object diagnostics only while `animEditorMode === "animationObject"`.

Shared selection lives in `AnimGraphEditingProvider`. Focus defaults to the active mode’s Graph panel.
