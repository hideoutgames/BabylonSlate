# Animation Graph

Worker-side Anim Graph (pose graphs and State Machines) plus per-instance Animation Object graphs that drive glTF Animation clips and Sprite Animation assets.

## Invariants

- `@haptic/anim-graph` has no React and no Babylon; the evaluator runs in the game worker.
- Render seeks `AnimationGroup`s and sprite frames from `animState` and never lets Babylon auto-advance gameplay animation. Groups stay paused with live animatables (`play()` then `pause()`); never `stop()`, which empties animatables and makes `goToFrame` a no-op.
- `animState` is an extra command-channel message ([bridge.md](bridge.md)), not a snapshot stride change. One `animState` per actor slot: the last graph in component order wins playback.
- Behaviour Tree Play Animation emits the same `animState`; there is no second playback clock.
- A player's Play Rate scales its clip duration, and a player at Play Rate 0 or below holds its pose: its clock never advances. Fact durations divide by Play Rate floored at 0.001 to stay finite.
- Pose and frame wires are structure, read by the evaluator; only data inputs compile. Phase 1 still plays through `AnimationGroup` weights: the evaluator flattens a graph into weighted clip layers (`AnimClipLayer`), with no per-bone pose buffers.
- Treat evaluated documents as immutable: derived lookups are cached per document object, so replace a document instead of mutating it.

## Ownership

| Area | Source |
| --- | --- |
| Schema, `animExitTimeReached`, validation, `resolveAnimGraphClips` | [`packages/anim-graph/src/graph.ts`](../../../packages/anim-graph/src/graph.ts) |
| Pose graph structure (node types, pose inputs, primary player, `createStateGraph`) | [`packages/anim-graph/src/pose-graph.ts`](../../../packages/anim-graph/src/pose-graph.ts) |
| Evaluator (`evaluateAnimGraph`, `animEvalWithJump`) | [`packages/anim-graph/src/evaluate.ts`](../../../packages/anim-graph/src/evaluate.ts) |
| Pose and frame node definitions | [`packages/scripting-nodes/src/anim-pose.ts`](../../../packages/scripting-nodes/src/anim-pose.ts) |
| Pose data compile (`compilePoseDataGraph`) | [`packages/scripting/src/compile-pose-data.ts`](../../../packages/scripting/src/compile-pose-data.ts) |
| Editor serialization | [`packages/anim-graph/src/serialize.ts`](../../../packages/anim-graph/src/serialize.ts) |
| Runtime host (`AnimGraphRuntime.tick`) | [`packages/runtime/src/anim-graph-runtime.ts`](../../../packages/runtime/src/anim-graph-runtime.ts) |
| Scene apply (`applyAnimStateToScene`, sprite frames) | [`packages/render/src/anim-apply.ts`](../../../packages/render/src/anim-apply.ts) |
| Model material slots | [`packages/render/src/model-preview.ts`](../../../packages/render/src/model-preview.ts) |
| Compile (`compileAnimGraphScripts`, with `instrumentExecutionTrace` for a Simulation) | [`apps/editor/src/services/script-compiler.ts`](../../../apps/editor/src/services/script-compiler.ts) |
| Editor document, mode bar, provider | [`apps/editor/src/components/document-workspace.tsx`](../../../apps/editor/src/components/document-workspace.tsx), [`apps/editor/src/context/anim-graph-editing-context.tsx`](../../../apps/editor/src/context/anim-graph-editing-context.tsx), [`apps/editor/src/shell/window-catalog.ts`](../../../apps/editor/src/shell/window-catalog.ts) |

## Document format

- Asset types `AnimationGraph3D` (document kind `anim-graph-3d`, `.anim3d.hasset`) and `AnimationGraph2D` (`anim-graph-2d`, `.anim2d.hasset`) share one document shape and one editor; `isAnimGraphAssetType` / `isAnimGraphDocumentKind` ([`document.ts`](../../../packages/core/src/document.ts)) test for either. The type is the dimension: a 3D graph plays `animation` clips on its `skeletonGuid` (null plays Animations with no Skeleton), a 2D graph `sprite` clips with `skeletonGuid` null. `validateAnimGraph(doc, catalog, { dimension })` reports `anim.clipKind` and `anim.clipSkeleton` on the state that plays the clip; the editor's clip picker lists only matching assets. The Animation Graph component's row warns when a 3D graph's Skeleton is not its actor's Model's.
- Fields: `skeletonGuid`, typed `variables[]` (bool / int / float / string / tag / Tag Container), `animGraph` (the top-level pose graph), `stateMachines[]` (`id`, `name`, `entryStateId`, `states[]` with `stateGraph`, `transitions[]` with `blendSeconds`, `priority` — lower wins, `ruleGraph`, side handles) and `animationObject` (a scripting graph seeded with protected Event Initialize / Update Animation).
- Every pose graph (`animGraph`, each `stateGraph`) has one protected output (`anim.pose.output` / `anim.frame.output`, id `output`); its type also gives the document's dimension (`animGraphDimension`). State Machine nodes (`anim.pose.stateMachine` / `anim.frame.stateMachine`) live only in `animGraph` and name their machine by `data.machineId`, one node per machine; the editor adds a machine for a new node and drops the machine of a deleted one (`withAnimGraphMachines`). The primary State Machine is the first the Anim Graph names (`primaryStateMachine`): Get Current State, Jump To State and the top-level `AnimEvalState` fields follow it.
- Transition ids are unique across the document (`anim.duplicateTransitionId`): rule class ids, breakpoints and `patchTransition` find a transition by id alone.
- Clip nodes (players, Sequence Evaluator) store `assetGuid`, filled `clipName`, `durationMs` and, for sprites, `frameCount` (`resolveAnimGraphClips`); 3D clips are Animation assets (a guid naming a Model resolves to nothing and plays nothing), 2D clips Sprite Animations. Node settings (clip, Loop, blend times, input `count`) live in node data; data pin values in `default:<pin>`.
- A state graph that is one player wired to the output (`singlePlayerOf`) is edited by the state's Inspector rows; any other graph is edited as a graph.
- Animation asset payload ([`animation-payload.ts`](../../../packages/assets/src/animation-payload.ts)): `durationMs` is the authored length of one pass (the Inspector's Duration) and `clipDurationMs` the clip's length in the source file, set at import and used as Duration's Reset default. A missing Duration defaults to the clip's length. Clip refs carry `durationMs`, and `resolveAnimGraphClips` refreshes it from the catalog at Play and export load, so the asset's Duration sets the playback rate; render seeks the group's authored frame range by normalised time, never by the asset's duration.
- Compiled class ids: `AnimGraph:{guid}` (Animation Object), `AnimRule:{guid}:{transitionId}` (`export function evaluate(ctx)` → `{ enter, exit }`) and `AnimPose:{guid}:{graphKey}` (`evaluate(ctx)` → `{ [nodeId]: { [pin]: value } }`, wired data inputs only; a graph with none compiles no module), all `parentClassId: "Object"`. `graphKey` is `anim` or `machineId/stateId` (`animPoseGraphKey`). Loading compiled scripts never instantiates actors.
- `AnimState.position` and editor-only `clipLabel` are presentation data; `__disabled` on One Way rules is canvas-only and stripped on persist.

## Evaluator

- Pure `(graph, dt, previous, inputs) → AnimEvalState`, deterministic and golden-tested. It walks the Anim Graph from its output; a State Machine node runs that machine's active state graph (and the one a blend leaves). Output: the primary machine's `stateId`, `normalisedTime`, `blendWeights` and timing `facts`; `machines` per State Machine; player clocks `players[graphKey#nodeId]`; Blend Poses By Bool / Int weights `selectors`; weighted `layers[]` (2D layers carry Flip Frame's `flipX` / `flipY`).
- Players keep their own clocks and advance whenever their graph is visited, even at weight 0; a fresh visit (state entry) restarts them at their Start Position or Start Frame. A state's facts follow its primary player (`primaryPosePlayer`: from the output through each node's first pose input), else a 1 s looping clock, and start where that player starts.
- Data inputs come from `inputs.poseData(graphKey, facts)` (the compiled module; facts are the owning state's before this tick's advance), else the node's stored default. Frames never blend: select nodes show one input, and render shows the heaviest sprite layer.
- A transition fires when both Exit State and Enter State are true; unwired sinks default true. `decideTransition` sees post-advance facts; `undefined` (missing class or throw) passes. An infinite-loop abort is rethrown.
- Blend length is captured when the blend starts so a duplicate `(from, to)` row cannot change it mid-blend.
- Exit Time Reached fires on crossing (Unity-style), once per loop for `exitTime ≤ 1`, once for `exitTime > 1`; non-looping states use a level test. Plain `normalisedTime` is post-wrap; use Exit Time Reached for end-of-loop thresholds.
- Missing entry state starts on the first state; transitions to missing states never fire. Nothing throws.
- `animEvalWithJump` replaces a machine's evaluation with the target state at `timeMs -1`, which the next evaluation enters fresh with no blend.

## Runtime

- `AnimationGraphComponent.graphGuid` attaches a graph. `AnimGraphRuntime.tick` visits only owners from the shared component owner index ([object-model.md](object-model.md)).
- Per component: seed its own copy of variable defaults → Initialize once per `componentGuid:graphGuid` → Update every tick → evaluate → set or clear the actor sprite clip.
- Evaluation and pending Jump To State belong to one graph guid; switching graphs restarts at the entry state. Jumps apply on the next `tickAnimGraphs`, so Actor `onTick` cannot race the evaluator.
- `self` in Animation Object scripts is the Actor. Actor Class graphs use `anim.actor.*` nodes with a required `AnimationGraphComponent` target; unwired targets are no-ops.
- Play/export load only Animation Graphs in the session dependency closure; editor Compile compiles every project graph.
- An Animation layer with neither clip name nor clip guid (a state with no clip) plays nothing and rests the slot's groups; it is not a missing clip. A named clip the slot lacks is warned once per slot and clip per Play session.
- Trace frames record per-component evaluation, graph guid and pending jump; restore does not re-run On Initialize Animation.
- The Simulation's graph debugger follows one `AnimationGraphComponent` ([debugger.md](debugger.md#simulation-graph-debugging)): `AnimGraphRuntime` reports, for it only, each State Machine's weighted states and taken transition under its own debug graph id `animStateMachineDebugGraphId(machineId)` (`state-machine:<id>`, `reportStateMachines`), and its Animation Object scripts get `ctx.debugTrace` through the component, their variable store. State and transition breakpoints use the same per-machine graph id. Transition rule and pose graphs carry no probes.
- A Flip Frame sprite layer mirrors the quad's UVs and pivot (render) and the frame's collision box (physics) through `flipSpriteAnimationFrame`.

## Render rules

- Clip lookup is per slot (`getAnimationGroups(slotId)`); never seek another actor's same-name group. With `clipAssetGuid` set, untagged groups do not match.
- Each Model is loaded once per Scene; actors instance under a `__importScale` child of an empty named root (`editorActor:<id>` / `actor-N`) so import scale never overwrites snapshot TRS.
- Material slots map by the glTF material index each primitive names (`modelMaterialIndexOf`), not child visit order; the file's own materials are never loaded. `MeshComponent.materialGuid` overrides the whole visual.
- `resolveAnimGraphClips` keeps Animation guids (never rewrites Animation → Model). Retargeted Animations load the source Model GLB and retarget at rest pose.
- A Model plays every Animation on its Skeleton: `retargetAnimationLoadsFromAnimations(animations, modelSkeletons)` ([`animation-payload.ts`](../../../packages/assets/src/animation-payload.ts)) lists, per Model, Animations retargeted onto it and every other Model's Animation on its Skeleton (`bindByName`); `beginSlotModelAnimLoad` binds the latter with `bindAnimationGroupByName` ([`node-rig.ts`](../../../packages/render/src/node-rig.ts)): same-named nodes and morph targets, the clip's keys shared unchanged. Play (`modelGuidsForPlayRetarget`) loads those source Models.
- `anim.skeletonMismatch` is an error when an Animation's skeleton differs from the owning Model's.

## Editor rules

- DockView document kinds `anim-graph-3d` and `anim-graph-2d`, with the same windows and focus keep keys (`anim-graph`, `animGraphObject`). The **State Machine | Animation Object** `AnimEditorModeBar` sits outside DockView; each mode has its own DockView surface, Windows list and Focus keep-list, persisted as `layout.json` `{ animEditorMode, stateMachine, animationObject }`. Only the active mode stays mounted.
- Rule palettes (`animationGraphHost: "rule"`) allow `anim.state.*`, pure nodes and Get Variable only; pose palettes (`"pose"`, with `animPose` dimension and level) allow the dimension's pose or frame nodes, State Machine only at the `anim` level, `anim.state.*` only at the `state` level, pure nodes and Get Variable; Object palettes (`"object"`) add `anim.event.*`; Actor palettes hide all and show `anim.actor.*`. Protected nodes: initialize/update events, Enter/Exit sinks and pose graph outputs.
- Navigation (`AnimEditorLocation`: `anim`, `machine`, `state`) lives in the editing context; breadcrumbs step out, double-click steps in (a State Machine node to its machine, a state to its graph). The Details panel edits machine and state rows on a machine canvas and is the node Inspector in a pose graph or rule.
- One directed `(from, to)` pair is one visual edge; Both Ways is two rows drawn as one edge. Extra rows warn `anim.duplicateTransition`.
- A selected state and a selected transition exclude each other; Open Rule selects the rule's transition. The State Machine passes the selected transition to `GraphEditor.selectedEdgeId` as its drawn edge (a reverse row maps to its pair's edge), so the wire stays highlighted when a rule closes.
- State names must be non-empty and unique (trimmed, case-insensitive). Diagnostics publish only for the active mode.
- Renaming or retyping a variable rewrites bound Get/Set nodes in `animationObject`, every rule graph and every pose graph.
- Pose and frame pins (`{kind:"pose"}`, `{kind:"frame"}`) connect only to their own kind (`isStructuralPinKind`) and draw heavy wires; pose nodes use the `anim-pose` (mustard) and control nodes the `anim-control` (amber) roles.
