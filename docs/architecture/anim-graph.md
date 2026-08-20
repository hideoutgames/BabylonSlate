# Animation graph (P9)

Worker-side state machine plus per-instance Animation Object graphs that drive catalog **Animation** assets (glTF `AnimationGroup` clips on the owning Model) and **Sprite Animation** assets (engineplan §13.2). Package `@babylonslate/anim-graph`: no React, no Babylon — the evaluator runs in the game worker.

`render` seeks `AnimationGroup` / sprite frames from `animState` and **never** lets Babylon auto-advance gameplay animation ([engineplan §2.3](../engineplan.md)).

## Document (schema v2)

`ANIM_GRAPH_SCHEMA_VERSION = 2`. Parse migrates v1 (`parameters` → bool variables; `condition` / `hasExitTime` → Exit State wiring).

| Field | Role |
| --- | --- |
| `states` / `entryStateId` / `clips` | FSM. Clip kind is `animation` (**Animation** guid + glTF `AnimationGroup` name) or `sprite` (**Sprite Animation** guid; Clip Name hidden). Legacy Sprite guid + clip name still resolves via `spriteClipFrameAt`. |
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

**Actor Class graphs** may use `anim.actor.*`. Get/Set Anim Graph Variable take a required `AnimationGraphComponent` target so they read and write that instance’s `variableStore` (wire **Get Component Ref**). `Get Current State` / `Jump To State` still target the first `AnimationGraphComponent` on `self`. `anim.event.*` / `anim.rule.*` / `anim.state.*` stay gated to Animation Object / rule hosts. Jump is pending until the next `tickAnimGraphs` so Actor `onTick` (inside `world.tick()`) cannot race the evaluator.

Protocol: extra command-channel `animState` (not a snapshot stride bump). See [bridge.md](bridge.md).

Drives:

- glTF `Animation` clips via `@babylonjs/loaders` `LoadAssetContainerAsync` (Play loads the **actor Model** GLB; groups are stamped with the **Animation** guid).
- Sprite Animation assets (and legacy Sprite named clips) from [sprites.md](sprites.md). `applySpriteAnimationAssetFrame` binds the current frame Texture, full UVs, pixel size, and pivot on the `SpriteComponent` quad. Duration for the evaluator is the sum of **effective** frame durations (`frameDurationMs`, or per-frame `durationMs` when `durationMsOverride` is true).

## Render

`applyAnimStateToScene` applies **all** weighted `layers[]` (or synthesizes one from `clipName`). Lookup is per-slot: `getAnimationGroup(slotId, clipName, clipAssetGuid)`, then `scene.animationGroups`. When `clipAssetGuid` is set, name-only / untagged groups do not match — two slots can both play `"Idle"` from different **Animation** assets. Missing clip → `onMissingClip` (create-engine skips the warn when no groups are registered yet). Sprite two-layer blend: base mesh + overlay; visibilities = weights. Overlay is created in `createPlayMesh` when a sprite frame exists and disposed with the slot. Pending `animState` is replayed after `assignMesh` and after GLB groups land.

Editor and Play use an empty named transform root (`editorActor:<id>` / `actor-N`, hidden and unpickable). Each Model guid is `LoadAssetContainerAsync`'d **once per Scene** from packed `source` bytes (`packedGltfBytes` copies a babasset chunk view); `instantiateModelsToScene` parents a per-actor instance under a `__importScale` child of that root so `payload.importScale` does not overwrite snapshot TRS (`createMeshFromModelBytes` is not the product path). A swallowed loader error leaves the empty named root with no visual meshes. After instantiate, `applyModelMaterialSlots` applies Model `materialSlots` to **every** `visualMeshes` part (skip hidden placeholder and 0-vertex `__root__`; keep loader UVs). Mapping is glTF `/materials/N` (import slot index), then construction name, then unused index — not child visit order. Parts that share a construction Material instance or the same construction name share a slot; distinct glTF materials are distinct slots. `MeshComponent.materialGuid` still wins as a whole-visual override. Snapshot TRS on the named root moves the whole glTF. Groups stay **paused with live animatables** (`start`/`play` then `pause()` — never `stop()`, which empties animatables so `goToFrame` is a no-op). Babylon must not auto-advance gameplay clips. Groups are stamped with the **Animation** guid (`modelClipAnimationGuids` keyed by owning Model; fallback is the Model guid when no Animation row exists), and the last `animState` is replayed. `clipName` is the glTF `AnimationGroup` name on that Model. Retargeted Animation rows load the **source** Model GLB from the same per-Scene cache and run `retargetAnimationGroupWithMeshProxy` at rest pose, then pause/seek.

## Compile / Play / export

`compileAnimGraphScripts([{ guid, path, document }])` emits `AnimGraph:{guid}` (Animation Object → `onInitializeAnimation` / `onUpdateAnimation`) and one `AnimRule:{guid}:{transitionId}` per transition (`export function evaluate(ctx)`). `parentClassId: "BObject"`. Failures log and skip that asset. `spawnListForScripts` only spawns `onBeginPlay` / `onTick`, so these classes do not spawn extra actors.

Play `collectPlayPreviewScripts` and export `collectAndExportGame` merge those bundles with Class/UI scripts. The packaged player hydrates `loadAnimGraphs` and `loadSprites` (Sprite + Sprite Animation payloads) before `play` ([exporter.md](exporter.md)). Editor Play parses graphs then `resolveAnimGraphClips` so worker layers carry the **Animation** guid + glTF group name (or a leftover Model guid + first `clipNames` entry), or a Sprite Animation guid + summed `durationMs`. `resolveAnimGraphClips` **keeps** Animation guids; it fills `clipName` / `durationMs` from the catalog and does not rewrite Animation → Model. Play collects Sprite Animation payloads referenced by **loaded graphs** and **behaviour-tree Play Animation** nodes (not only open tabs), plus their Textures. Packed Animation JSON hydrates `modelClipAnimationGuids` and `retargetAnimationLoads` so export Play stamps the same guids. Behaviour-tree **Play Animation** emits the same `animState` command (no second playback clock).

## Authoring

DockView document (`DockviewShell`, kind `anim-graph`), not `AssetDocumentWorkspace`. Chrome **State Machine | Animation Object** `AnimEditorModeBar` (`ToggleGroup`) sits **outside** DockView — same pattern as UserInterface **Designer | Logic**. `documentKind` stays `"anim-graph"`; modes use `animEditorMode` and DockView surfaces `stateMachine` / `animationObject`. `layout.json` stores `{ animEditorMode, stateMachine, animationObject }`; a raw old snapshot migrates to State Machine. Mode switches keep only the active DockView mounted. Inactive document tabs idle-unmount (`p18-inactive-documents`).

| Mode | Catalog (Windows / Focus) | Primary |
| --- | --- | --- |
| State Machine | Graph, Variables, Details, Compiler Results | `anim-graph-graph` |
| Animation Object | Graph, Variables, Inspector, Compiler Results | `anim-object-graph` |

Engine Settings Focus keep-lists: **Animation Graph State Machine** (`anim-graph` → Graph) and **Animation Graph Object** (`animGraphObject` → `anim-object-graph`).

### State Machine

- **Variables** (left) — compact `--chrome-row` (28px) name `Input` + type `Select` `size="sm"` and trash `IconActionButton`. **Add Variable** / **Add State** use `Button` `size="sm"` (not 44px touch). States are a compact selected list (`bg-primary/20` + ink bar). Keeps `data-testid="anim-graph-parameters"` for existing e2e. Selecting a state from the list or canvas updates Details **without** `fitView` / `focusedNodeId`; only compiler diagnostics / Frame zoom.
- **Graph** (primary) — `GraphEditor` with `animGraphNodeTypes` / `animGraphEdgeTypes`, `defaultEdgeOptions` type `animTransition`, `uniqueDirectedPairOnConnect`, `connectEndMode="zone-add-node"` (far empty-canvas release opens Add State; release on or near a compatible pin — including an occupied plate — snap-connects; near-source tap/release and a second pointer cancel without breaking transitions). One directed pair `(from, to)` stays one visual edge (reconnect updates handles). Unreal-style rounded state nodes (`min-width: 200px`, `min-height: 88px`) with **four thin side handles** (~16px plates, geometric ticks; the body is the 44px move target). Each side stacks `*-in` and `*-out`; dropping on the source plate still becomes a transition after handle migration rewrites it to the input plate. Directed `MarkerType.ArrowClosed` paths use a more open bezier stub (`animTransitionPath`); **Both Ways** is two `AnimTransition` rows that render as one visual edge with arrows on both ends. CSS-triangle blend badges rotate with the edge tangent. Single-click a badge selects that blend rule exclusively (deselects states and other badges; Details). **Break Links** then deletes only that visual edge (and the hidden reverse Both Ways row). Details **Open Rule** (not the badge) opens a nested rule graph: breadcrumb `State Machine > Source To Target`, undeletable Enter/Exit sinks. **One Way** dims **Exit State** (unused reverse) and compile/eval treat it as always true (`__disabled` is canvas-only; `persistTransitionRuleGraph` strips it); **Both Ways** keeps both sinks live on each directed rule. Palette: `scriptPaletteNodes(..., { animationGraphHost: "rule" })` — `anim.state.*` queries, pure math/bool, Get Variable; no events, no Set Variable, no `debug.log`. A palette pick from a dangling wire auto-connects the **opposite** side (`right-out` → `left-in`).
- **Details** (right) — selected state (name, entry, **Clip Kind**, **Clip Asset**, **Clip Name**, speed, loop) and outgoing **Blend Seconds** / **Priority** / **Direction** (`One Way` | `Both Ways`) / **Flip Direction** (enabled only for One Way; swaps `from`/`to` and pin plates, then selects the new source state so Details stay on that blend) / Open Rule. While a To State rule is open, Details shows the selected scripting node (Inspector); **State Machine** in the breadcrumb restores state/transition Details. Clip Kind **Animation**: Clip Asset is **Animation** catalog rows only (`allowedTypes: ["Animation"]`, picker title **Pick Animation**). Clip Name is hidden unless a leftover `clipAssetType === "Model"` row is still bound (then a `SearchDropdown` of Model `payload.clipNames`). Empty catalog shows disabled **No Clips**. Clip Kind **Sprite**: Clip Asset is **Sprite Animation** only; Clip Name is hidden. `kind: "animation"` `assetGuid` is the Animation Play seeks (`clipAssetGuid` on stamped groups). The actor still loads the **Model** GLB from `MeshComponent.assetGuid`. `validateAnimGraph` emits `anim.skeletonMismatch` when that Animation’s `skeletonGuid` does not match the owning Model’s `skeletonGuid`. Importers store Model `clipNames` and `skeletonGuid` on the header payload.

`AnimState.position` round-trips through `animGraphToSerialized` / `serializedToAnimGraph`. Transition blend / priority / `ruleGraph` merge when canvas edge ids change.

### Animation Object

Reuses Class **Graph** / **Inspector** panels (`GraphPanel`, `InspectorPanel`) with `parentClass` BObject and `animationGraphHost: "object"`. Palette: `anim.event.*` plus runtime-safe nodes; hides rule/state queries, Begin Play, BT. Variables panel is the same typed list without States. Renaming or retyping a variable rewrites bound Get/Set nodes on `animationObject` and every `transition.ruleGraph`. `serializedGraphFromDocument("anim-graph")` returns `animationObject` with injected `members` from `variables`. Commits write `{ nodes, edges }` without dropping states (`commit.kind === "anim-graph"`). Open AnimationGraph tabs are skipped by `collectClassGraphsForPalette` so they are not treated as Class palettes.

### Palettes and protected nodes

`ClassEventOptions.animationGraphHost?: "object" | "rule"`. Actor palettes hide `anim.event.*` / `anim.rule.*` / `anim.state.*` and show `anim.actor.*`. `PROTECTED_NODE_TYPES` includes `anim.event.initialize` / `update` and `anim.rule.enterState` / `exitState`. `nodeVisualRole` paints those as events.

### Diagnostics

State Machine publishes `validateAnimGraph` (plus nested `validateSerializedGraph` when a rule is open) only while `animEditorMode === "stateMachine"`. GraphPanel publishes Animation Object diagnostics only while `animEditorMode === "animationObject"`. `anim.skeletonMismatch` is an error on the clip when the picked Animation’s skeleton is not the Model’s.

Shared selection lives in `AnimGraphEditingProvider`. Focus defaults to the active mode’s Graph panel.
