# Bridge protocol (P4)

Shared surface for main-thread ↔ game-worker transport (engineplan §2.1, §2.4, checklist `p4-bridge`). Implementation: `@babylonslate/bridge`.

This is **not** the P3 JSON harness snapshot (`createWorldSnapshot` in `@babylonslate/object-model`). Harness goldens stay JSON; Play and the renderer use the binary layout below.

## Editor session admission and release

`GameSessionOwner` is the headless admission authority for Play and packaged Preview. Its ticket carries a mode (`play`, `simulate`, or `preview`), monotonic generation and cancellation signal; `simulate` uses the internal Scene Viewport integration; the public launch action remains gated until live editing is qualified. Lifecycle is separate from mode. Preparation checks the ticket after each asynchronous result before publishing it, so cancelling or closing the project cannot launch a stale prepared scene. Existing save/migration choices still precede admission, and cancelling preparation does not cancel an already-started authoring save.

Play presentation can close while the owner remains `stopping`. A second session and project Engine replacement wait for `PlaySessionResult.released`; an unconfirmed/rejected release quarantines admission and reports that the editor must reload. Closing React chrome and an elapsed timeout do not establish native release. Preview keeps its packaged iframe path and releases admission when that browsing context detaches. The presentation passes its generation into Play startup; StrictMode's abandoned effect setup never allocates a second game owner. Pause acknowledgment and simulation editing use separate runtime boundaries; admission alone does not acknowledge a paused tick. After Stop, editor Play no longer applies queued runtime commands or snapshots; their log and diagnostic messages still reach the log, and a final diagnostic recording still completes. Worker Play posts `stop` and keeps the worker and its save storage server until the worker reports `runtimeStopped` (its stop phase ran End Play and On Game End and their save writes were answered), or for at most 3 s, before terminating it; `released` waits for that termination, so the next session's save writes and wipe-on-play reset cannot interleave with End Play saves. The exported player still terminates its worker at Stop.

The internal `requestSimulate` path reuses Play preparation with an explicit open world Scene, independent of startup-scene preferences. Preparation fixes the open-document source snapshots at launch, derives their typed required dependency closure (including unsaved Class/Structure schemas), and includes those working identities in source/compile cache keys. Later demand loads use the same snapshots and retain scoped binary leases; Simulation does not force-save or restore eager project-wide payload collection. It first drains admitted project writes, then leases the authoring lock and preserves the in-memory scene document. Save Game preparation (including wipe-on-start) and gameplay share one disposable storage overlay. A world-only `SimulationViewport` adapter releases the authoring handle and waits for `whenReleased()` before the existing game presentation mounts through a portal into that panel. Cancellation retains an outgoing-release barrier. After game release, authoring presentation reconstructs from the unchanged baseline or the successfully retained scene through the normal viewport path, retaining the SceneEditingProvider's selection and stored camera pose. Keep is snapshotted at launch; its complete capture and admitted command run before native cleanup. Discard requests no final scene serialization.

Simulation's chrome acknowledges whole-session pause requests before showing the result, separates Game Input and Edit, and omits Step. The existing runtime host neutralizes input and freezes game progression; camera-only redraw remains a render-owner capability. The source Scene stays in the document working set while Simulation is active, and a global Stop/Return To Scene bar remains outside hidden document tabs. The existing Inspector/Outliner and transform tools use the runtime adapter below. Public launch/browser qualification remains tracked in [engineplan §9.8](../engineplan.md); `__babylonslateSimulationTest` is test-only and never exported to players.

Shared `@babylonslate/input` owns DOM input capture for editor Play and packaged
Preview, including neutralization and fresh-transition admission. The correlated
session-boundary client lives in `@babylonslate/bridge`; editor compatibility
exports reuse it. Preview input ownership and pause requests validate source,
origin and session identity without arming diagnostics. Capture waits for the
acknowledged boundary and preserves independent lifecycle/user reasons. When the
latest Preview boundary fails or times out, the player releases the view freeze
and input hold it placed; explicit editor input suppression still applies.
Editor Play's virtual sticks go through the same capture. Once a pause or an
editor surface has taken input, Resume or closing the surface returns keyboard,
pointer, gamepad and stick input after a fresh transition. A failed input reset
still ends its transition; a failed Simulation mode switch keeps the previous
Game Input or Edit mode.

## Transports

| Path | Where | Mechanism |
| --- | --- | --- |
| Transferable ping-pong | Worker → main thread in every Play and player session (the only production path) | Copy the published snapshot into a recycled `ArrayBuffer` and transfer it; never require SAB |
| SAB seq-lock | Inside the runtime: the driver's published double buffer | `SharedArrayBuffer` + `Atomics` seq-lock when available, plain `ArrayBuffer`s otherwise |

Both share the same `Float32Array` layout. Main-thread reads of the shared buffer when `crossOriginIsolated` are not wired; that remains an optional optimisation, and CI exercises transferables.

Cross-origin isolation on Pages uses `coi-serviceworker.js` in `apps/editor/public/` (reload once on first visit).

## Snapshot buffer layout

Double-buffered `Float32Array`. Views are little-endian; header and per-actor slots use float indices (not byte offsets).

### Header (floats 0..15)

| Index | Name | Type meaning |
| --- | --- | --- |
| 0 | `magic` | `0x42534e50` bits as f32 (“BSNP”) |
| 1 | `version` | Layout version (`2`) |
| 2 | `frameId` | Monotonic render/sync frame, stored as raw u32 bits like `seq` so it stays exact past 2^24 |
| 3 | `tickIndex` | Last completed simulation tick, raw u32 bits |
| 4 | `actorCount` | Occupied slots |
| 5 | `scriptMs` | Script phase time for last tick |
| 6 | `physicsMs` | Physics phase time (separate from `scriptMs`; HUD reads the 5 Hz `stats` command, but this header field is per-tick) |
| 7 | `seq` | Seq-lock sequence (even = stable) for SAB |
| 8 | `layoutGeneration` | Installed snapshot-layout generation |
| 9–11 | origin high | Camera-relative origin, high float components |
| 12–14 | origin low | Origin residual components |
| 15 | origin generation | Origin change counter in the same published snapshot |

### Per-actor slot

`SNAPSHOT_HEADER_FLOATS = 16`, `SNAPSHOT_ACTOR_STRIDE = 16`.

Slot `i` starts at `16 + i * 16`:

| Offset | Name |
| --- | --- |
| 0 | `slotId` (dense integer id as f32) |
| 1–3 | `position` xyz |
| 4–7 | `rotation` quaternion xyzw |
| 8–10 | `scale` xyz |
| 11 | `flags` (`SNAPSHOT_FLAG_VISIBLE` = bit 0, `SNAPSHOT_FLAG_OVERLAY` = bit 1 = SceneLayer HUD; layout version unchanged) |
| 12–14 | position residual | Low components of positions relative to the origin |
| 15 | reserved |

**Actor guid ↔ slotId** is maintained on the reliable command channel (`spawn` / `despawn` / `remap`). Guids never travel in the hot buffer.

`maxActors` is the initial allocation, not a user-visible Actor limit. Dense slot IDs are recycled after despawn, and capacity grows geometrically before an out-of-range ID is assigned. Growth is subject to memory and performance budgets and allocation success; it is not a promise of mathematically unlimited Actors.

Each replacement has a monotonically increasing `layoutGeneration`. The writer allocates a complete replacement pair, sends ordered `snapshotLayout { capacity, generation }`, and waits for `snapshotLayoutAck` before publishing. SAB mode hands off new buffers because an existing `SharedArrayBuffer` cannot be resized portably; transferable mode replaces both ping-pong buffers under the same handshake. The receiver replaces capacity-sized scratch/index storage and ignores frames from every non-installed generation. Writer rows remain `[0, actorCount)` and interpolation matches recyclable `slotId`, not row index.

Copies carry only the active span (`snapshotActiveFloatCount`: header plus `actorCount` rows), not the whole capacity: seq-lock reads, the worker's transfer buffer and `SnapshotSampler.push`. Buffers are not zero-filled, so rows past `actorCount` can hold an earlier, larger frame; readers must never read past `actorCount`. The sampler ignores a snapshot whose `actorCount` needs more rows than its buffer holds. Capacity still only grows.

`SNAPSHOT_FLAG_VISIBLE` reflects the actor's canonical runtime `visible` variable, initially copied from `SerializedActor.visible`. Scripts can change that variable while playing and the next snapshot updates the renderer. Visibility is per actor: a hidden parent does not implicitly hide a separately rendered child actor.

## Channels

| Channel | Direction | Payload |
| --- | --- | --- |
| Control | main → worker | `load` (`sceneAssetGuid`, optional authored `scene`, `seed`, `physicsWorld`, `gravity`, `havokWasmUrl`), `loadScripts`, `loadAnimGraphs`, `loadSprites` (Sprite + Sprite Animation payloads, optional `pixelsPerUnit`), `loadTilemaps` (tilemap + tileset payloads, optional `pixelsPerUnit`), `loadBehaviourTrees` (`trees` plus optional `blackboards` documents), `loadWater` (Water documents), `loadNavMesh` (baked navmesh bytes for the current scene, a private copy the editor host transfers and the player host clones; omitted when `load.sceneNavmeshBytes` already holds that scene's mesh), `loadModels` (Model JSON headers plus cooked complex-collision `Float32Array` positions / `Uint16Array` or `Uint32Array` indices, only for Models the content scan marks — not the raw GLB), `loadComplexCollision` (answer to the worker command `requestComplexCollision`; meshes or `unavailable` guids), `play`, `step`, `stop`, `setPaused`, `console` (`line`), `inspect`, `sceneLayerResize` (`frustumWidth` / `frustumHeight`, optional `canvasWidth` / `canvasHeight` for Project Cursor NDC) |
| Commands | worker → main (ordered; batched per tick, see Command batching) | `spawn`, `despawn`, `assignMesh` (`meshAssetGuid` + `meshKind`, optional `sceneLayerId` for HUD overlay routing, optional `light` / `camera` / `skybox` / `text3d` payloads, optional `parts[]` for extra component meshes with local TRS), `possessCamera` (`slotId`), `setScalability` (`transaction`: revisioned session render settings — quality, render path, frame cap, resolution; never persisted), `setLightsDebug` (`enabled`), `assignMaterial`, `activeScene` (`sceneAssetGuid` after `changescene` / `ctx.changeScene`, canonical guid even when the call used a display name), `log`, `print` (keyed HUD; not debugger-gated), `debugDraw` (Play wireframes; not debugger-gated), `diagnostic`, `stats`, `tilemapAnimationTime` (`elapsedMs`, simulation clock for animated atlas UVs), `animState` (`slotId`, `stateId`, `normalisedTime`, `blendWeights`, optional `clipName` / `clipKind` / `clipAssetGuid` / `justFinished` / `justLooped` / `layers[]`), `playSound` (`assetGuid`, `volume`, `frameId`, optional `emitterActorGuid` / `loop` / `voiceId` / `clipRoll` / `pitchRoll` — the runtime's clip and pitch draws — / `startOffsetSeconds` — seconds already played — and `restoredAtSeconds`, both sent by trace restore), `audioSimTime` (`seconds`, runtime audio clock — undilated simulation time, excluding pauses — while trace-restored voices are live), `stopSound` (`voiceId`), `setVoiceGain` (`voiceId`, `volume`; a live voice's play-call volume — both Play hosts forward it to the audio service), `setChannelVolume` (`channelGuid`, `volume`), `setGlobalVolume` (`volume`), `assignParticle` (`slotId`, `actorGuid`, `componentId`, `particleSystemGuid`, optional `play`, optional `sortingLayer` / `orderInLayer`), `setParticlePlaying` (`actorGuid`, optional `componentId`, `playing`), `setCursorVisible` (`visible`; Play CSS cursor, default hidden), `setGamepadRumble` (`gamepadIndex`, `intensity` 0..1, `durationMs`; pad `dual-rumble`, zero stops), `waterTime` (`seconds`, `frameId`), `cableFrame` (`frameId`, packed `data`), `consoleResult` (`success`, `output`), `runtimeStopped` (the `stop` phase finished, including its save writes), `inspectSnapshot` (`tickIndex` + node list, optional `variableTypes`), `btState` (`slotId`, `status`, `btNodeId`, `lastResults`, `blackboard`, `stack`; live behaviour-tree overlay) |
| Input ring | main → worker | Tick-stamped raw events (see `@babylonslate/input`). Play stamps with the last snapshot header `tickIndex` (`snapshotTickIndex`); `stats` is **not** a hot-path channel (~5 Hz) and must not be the stick clock. The driver applies every queued event each tick so a host/worker clock skew cannot drop sticks. |
| Snapshots | worker → main | Hot-path transform buffers (transferable; latest-state, at most two outstanding) |

Structural and resource changes **never** go through the snapshot buffer.

**Stats command:** `{ type: "stats" }` is **not** a hot-path channel. The worker emits it at ~5 Hz (`STATS_COMMAND_INTERVAL_MS` = 200). It carries `scriptMs`, `physicsMs` and `publishMs` (optional on the type; the runtime always sends it): the most recent snapshot publish, covering the per-tick SceneLayer overlay layout and removal pass, world composition and buffer write. The snapshot header carries the `scriptMs` / `physicsMs` / `tickIndex` of the last publishing tick (see Snapshot cadence). Overlay Play and the packaged player stamp input from `snapshotTickIndex`, not from sparse `stats`.

**Snapshot cadence:** hosts copy once after `advance()` (and on `sceneRealized` / `sceneLayerRealized` / `sceneStreamRealized`, each preceded by an immediate publish; when no snapshot can be copied yet, the realized command reaches readiness with the next published snapshot instead of failing the load), so the runtime writes one snapshot per catch-up burst, with the header of the burst's last publishing tick. `spawn` / `despawn`, `sceneLayerLayout` and the other commands keep their per-tick order. A bare `tick()` (Step, replay) and the synchronous scene, SceneLayer and stream readiness publishes and SceneLayer scrolling write immediately. If a burst tick pauses the session or starts a blocking stream load, the remaining ticks do nothing and the burst still writes its pending frame. The write composes poses at the end of the burst, so a tick that starts a blocking load after other actors moved or were destroyed in that tick shows those moves early and leaves those actors out (per-tick writes showed both when the load finished). Overlay layout still runs before that write, so overlay actors moved in that tick are laid out, as in every written frame. The `despawn`, slot release and stream retirement for that tick's removals wait for the next publish, as with per-tick writes. The origin generation and `seq` count written frames, so a burst whose camera crosses origin cells more than once advances the generation once; the origin itself matches the last tick.

`load` may set `deferSceneModelsReady`. Runtime emits
`activeScene { sceneAssetGuid, sceneLoadId }` before spawning and
`sceneRealized { sceneAssetGuid, sceneLoadId }` after all world and owned SceneLayer
resource commands. IDs start at one and increase for each load, including reloads
of the same asset. The deferred finish latch is installed before `sceneRealized`,
so an in-process host can acknowledge immediately without losing readiness.

Overlay Play and the player post
`{ type: "sceneModelsReady", sceneAssetGuid, sceneLoadId }` only after the matching
assignment batch, textures, shader warming and first frame are ready. Game Instance
**On Scene Finish Loading** accepts only the exact pending GUID and load ID;
early, stale, duplicate, empty-GUID and post-Stop acknowledgements do not complete
another load. Game Instance ticks remain active while rendering loads. Headless
hosts that omit `deferSceneModelsReady` finish synchronously after owned layers
are realized. Hosts use load identity, rather than GUID equality, to recognize
subsequent reloads of the same asset.

`loadScripts` registers classes without creating Actors when `spawn` is omitted or empty. Editor Play and the player send an empty list; actors come from the authored scene or explicit Spawn Actor calls. Explicit `loadScripts.spawn` requests are filtered with `shouldSpawnScriptedActor` so `GameInstance`, `FunctionLibrary`, `EditorUtilityObject`, `EditorFunctionLibrary`, `SceneLayer`, and `Scene` never become Actors.

## Transport parity

Scenario results must match across the in-process runtime (`createInProcessRuntime`) and the worker's transferable path; the seq-lock and transferable primitives share a parity test. There is no RPC channel or Comlink: hosts use the typed control / command / input / snapshot messages above.

## Play game Worker

Play prefers a dedicated Worker from `@babylonslate/runtime/worker-entry` (`createGameWorkerHost` in the editor). If Worker construction fails (host/Vite), Play falls back to `createInProcessRuntime` and logs a warning. Both paths share control / input / snapshot / command channels. The `load` message includes the open scene's `physicsWorld` / `gravity` and the vendored `/havok/HavokPhysics.wasm` URL so `loadPhysics()` can construct `HavokPlugin` (3d) or Rapier (2d) instead of staying on the AABB software backend.

Cooperative loads emit `sceneLoading { sceneAssetGuid, sceneLoadId }` before departing lifecycle hooks or resource removal. Hosts that set `deferSceneLoadingPaint` acquire their blocking Loading UI and post the matching `sceneLoadingPainted` control after it paints. The runtime installs that latch before notifying the host, rejects obsolete tokens, and fails after 30 seconds without a paint acknowledgment. Stop aborts the wait immediately. `sceneLoadFailed` identifies a failed current transition; it never releases Scene readiness. The later `activeScene` uses the same ID after outgoing despawns, so renderer activation does not perform a second full removal of the departing world. The snapshot transport discards an older held batch as soon as a new loading token arrives.

Outgoing actor removal uses the same bounded chunk scheduler as incoming realization. Global SceneLayers stay live; departing world/owned-layer objects and native bodies retire (their destruction committed) before any replacement is created, so a reloaded Scene's actors reuse their guids without ever sharing one with a live actor ([object-model.md](object-model.md#unique-actor-guids)). Supersession transfers unfinished cleanup by object identity to the replacement. Stop and failure cleanup remain immediate. One actor's lifecycle hooks and final native synchronization are indivisible.

Play and exported player hosts enable the cooperative runtime path (`cooperativeSceneLoading`) through their shared load factory. It rejects a Scene that repeats an actor id before creating anything, creates the complete Actor set before realization and preserves the owned SceneLayer remap, spawn, design-pose, anchor, and assignment passes. Chunks yield after at most 32 Actor operations or 8 ms; one Actor/component setup remains indivisible. The immediate runtime and public `createSceneLayer` APIs preserve synchronous behavior. Cancellation tracks actual Actor and SceneLayer instances, so a stale load's cleanup cannot remove a replacement that reuses its guids. Failed preparation retains its rejected readiness latch. Scene replacement removes departing physics bodies before Actors reusing their guids appear, so old poses and velocities cannot overwrite authored state; global SceneLayer bodies remain live.

Game Instance ticks continue during cooperative boot and scene preparation. Actor, component, physics, animation, and behaviour-tree work stay suspended until the complete scene and renderer readiness acknowledgement; native physics boot has a separate gate. The initial completed batch is announced only after native physics initialization succeeds; a replacement during that wait supersedes the held batch. Scene changes from a Game Instance tick recheck the gate before the remaining phases. Actor-owned delays pause during preparation while Game Instance delays continue. Partial preparations publish no snapshots. The full authored world pose is pushed before the realization command; the Worker holds that command through snapshot-layout acknowledgement when capacity grows. Stop and replacement Load discard held markers and cancel boot waiters, preventing late script/physics completion from starting or resuming another session. Explicit Pause on Play applies as soon as the early Game Instance scheduler starts and survives boot completion.

The worker loop uses worker `requestAnimationFrame` when the host exposes both scheduling and cancellation. Other worker environments use a monotonic `performance.now()` timer fallback. Both feed elapsed time into the runtime's fixed-step accumulator (including its catch-up cap), and Stop or a replacement Load cancels either kind of pending callback. A frame that throws still schedules the next one; the error reaches the worker's `error` handler below. A `step` control pauses again even when its tick throws.

Diagnostics: `worker-entry.ts` mirrors the in-process driver's `reportError` on the worker's own uncaught `error` / `unhandledrejection` handlers, emitting the same `diagnostic` command shape (including optional `bodyLine`). `play-session.ts` feeds every `diagnostic` command into a `SessionDiagnosticAggregator` on the main thread (`diagnosticFromCommand`) so the Preview session report is populated for the Worker transport too, not only the in-process fallback. `Log` at Error severity also emits `runtime.log` diagnostics (not only the log ring / Output Log).

### Command batching (worker → main)

Plain commands (the steady-state `animState`, `log`, `diagnostic` and similar) are queued in `worker-entry.ts` and posted as one `{ channel: "commands", payload: CommandMessage[] }` message instead of one structured clone each. The single `{ channel: "command" }` message stays valid.

- **Order is unchanged.** The queue is flushed at the end of every incoming message handler, at the end of each tick (`pump`; a `step` control ends with its handler), at the end of the worker's `error` / `unhandledrejection` handlers, and before every other post (poses, transferable commands, `snapshotLayout`, simulation capture chunks), so a pose or transfer never overtakes a command emitted before it and nothing waits for the next tick. Commands emitted from a promise or timer continuation (inspector, console, quiesce and boundary replies) flush in a microtask.
- **Held replies stay put.** `sceneRealized` markers and `afterPose` replies are queued only once their pose has been posted, so they follow it, and the queue is flushed right after the replies are released. Transferables and each `snapshotLayout` keep their own posts, and the host acknowledges every layout.
- **Hosts** (`createGameWorkerHost`, `createPlayerWorkerHost`) hand each command of a batch, in order, to the same dispatch as a lone `command` through `dispatchCommandBatch`: a throwing handler does not skip the rest of the batch (the first error is rethrown afterwards, later ones surface as their own uncaught errors) and a host torn down mid-batch receives nothing more.
- A command the structured clone rejects cannot drop its batch: the others are posted alone, in order, and the failure is reported as an uncaught worker error (which becomes a `diagnostic`). The clone now happens at flush rather than at emit, so emitted command payloads must not alias state that runtime code mutates later in the same pump (one pump can run several catch-up ticks): copy at the emit boundary, as `debugDraw`, `print`, `setUIControl2D` and the capture lens transform do.
- The in-process runtime (`createInProcessRuntime`) hands commands to its host directly and does not batch.

### Snapshot buffer recycling (transferable path)

The Worker's per-frame snapshot is produced by `TransferablePingPong` (`packages/bridge`), not a fresh `ArrayBuffer` per tick. The host recycles the consumed buffer back to the worker over a `recycleSnapshot` host message once its synchronous consumer (`SnapshotSampler.push`, which copies into its owned buffer immediately) is done with it, so a warmed-up Play session allocates no new snapshot buffer per frame. A frame with nothing to publish (`copySnapshot` returns `false`) calls `cancelWrite()` to return the buffer to the free pool rather than leaking it. The free pool keeps at most two spare buffers.

Backpressure: poses are latest-state. The worker counts transferred snapshots until their `recycleSnapshot` returns (stale layout generations are returned too). With two outstanding it skips the tick's pose instead of queueing another transfer; when a buffer returns it publishes the newest pose at once. Realized markers (`sceneRealized`, `sceneLayerRealized`, `sceneStreamRealized`) stay held until a pose snapshot is sent, then follow it. A successful runtime Inspector edit reply (`runtimeInspectorResult` with a `mutation` payload) is held the same way, in order, so a paused host never redraws an older pose; held replies are sent on the next pose, or immediately on `load`/`stop`, and are never dropped. Poses are the only latest-state data: header fields (tick, frame, origin) are always the newest, and no other state rides on a snapshot. Other structural commands are never held; `snapshotLayout` is announced only once its transfer buffers are allocated. If the worker cannot allocate them for a new layout, it reports the failure once, holds poses, and retries the newest layout on every later publish before announcing it. Hosts recycle in a `finally`, so a throwing consumer cannot stall poses.

This still layers over `postMessage` transfer per frame; true zero-copy `SharedArrayBuffer` main-thread reads (no message per frame at all) when `crossOriginIsolated` remain unwired — a follow-up, not required for correctness since transferables are the CI-mandatory path.

## Seq-lock (SAB)

1. Writer increments `seq` to odd before writing.
2. Writer copies header + slots, then sets `seq` to even (`magic` + layout version are written here).
3. Reader samples `seq`, copies the header and `actorCount` rows, re-reads `seq`; if odd or changed, retry (bounded).
4. `tryRead` returns `false` until a buffer has been published. Spare seq-lock slots are zeroed; treating that as `actorCount: 0` would despawn every Play mesh created by `assignMesh` and drop `assignMaterial` records before the first tick. `isPublishedSnapshot` requires header `magic` + layout version. A published snapshot with `actorCount: 0` (empty scene) is still valid.

## Related docs

- [object-model.md](object-model.md) — JSON harness snapshot vs this layout
- [design/perf-budget.md](../design/perf-budget.md) — editor viewport / Play budgets
- [render.md](render.md) — snapshot apply + resource cache (P4)

Snapshot layout version 2 retains the 16-float header and actor stride. Positions are relative to a camera-selected 1024-unit origin cell. Header origin and actor residuals preserve precision without increasing transport bytes. Readers reconstruct authored world coordinates before interpolation, so a change of origin is atomic and cannot create an interpolation jump. This does not change authored transforms or imply unlimited physics precision.

Simulation's existing Inspector and Outliner use one headless `SimulationInspectionStore`.
The store requests the runtime identity tree by structural revision and details only
for the exact selected scene-instance/GUID/lifetime-token tuple. Visible DockView
consumers admit serialized reads at no more than 5 Hz; hidden documents and panels
release their subscriptions. The tree is capped at 4,096 identities or 512 KiB of
accounted serialized strings, and property/value pages retain the bridge's 64 KiB
message bound. Additional pages require explicit navigation. These are retained-data
limits, not browser heap measurements.

Live controls reuse `PropertyGrid`, with runtime capability descriptors, protected
focused drafts, correlated acknowledgements, and explicit pending/rejection state.
Only validated runtime controls override the editor's read-only presentation context;
source asset creation and structural authoring stay locked. A polling response older
than an accepted command revision cannot overwrite its acknowledged value. Timeout,
selection invalidation and Stop send correlated `cancelRuntimeInspector` requests,
so a rejected deferred material/source preparation cannot later apply. A synchronous
write that already completed cannot be recalled. Material
instance edits use typed material requests, while assignment uses the component's
validated property owner. Expanding a container requests one bounded value page,
without starting another polling system. Runtime selection is kept separately from
the immutable authored selection and never changes automatically when slots recycle.

Runtime picking resolves the render slot and actor GUID through the authoritative
runtime before changing selection. Transform tools bind that exact identity and
render-slot metadata, reuse the existing gizmo host, and submit coalesced world-pose
requests; the runtime converts them against the authoritative parent. The final
commit is acknowledged before the draft proxy follows the next runtime pose. Edit
input and viewport visibility own the gizmo subscription; Game Input and hidden
views disable its controls and release detailed polling.

Every Stop route passes the common owner's asynchronous retention admission gate.
A refused capture leaves the ticket un-aborted in `retention-resolution`, with
Retry/Discard controls; native End Play and release cannot run first. Successful
admission then finalizes diagnostics, disables capture leases, and stops the native
runtime. The local Keep preference is snapshotted at preparation; source controls track
the current leased asset metadata after on-demand acquisitions. Unsupported initial or runtime topology is shown explicitly;
quiescence still precedes any failed Stop resolution. Source-document and project
transitions await Stop and actual release before recovery cleanup or replacement.
Unexpected host teardown requests discard, while an unconfirmed native release
keeps the authoring protection and shared Engine quarantined until reload. The
Keep write itself is atomic: a Discard that arrives after it started waits for
it, and takes effect only if the write fails.

### Final authoring capture transport

`quiesceSimulation` is correlated by session generation and request ID. It rejects
new mutations, settles accepted writes at a completed boundary, and reports tick,
scene/load identity and command revision without running End Play. A failure while
settling answers at once with an unsuccessful result that a newer request ID can
retry, instead of leaving the request to the host's timeout. The host drains
that exact render revision, including staged material preparation, before sending
`captureSimulationState`. A mismatched revision, stale identity or unconfirmed
resource owner fails the capture. Worker and in-process hosts use the same capture
service; Inspector/trace snapshots are never used as a fallback.

Successful candidates travel in ordered, bounded 64 KiB UTF-8 chunks followed by
a correlated summary. Count, sequence, byte budget, JSON shape and identity are
validated before publication. A worker `load` or `stop` that supersedes a transfer
still ends it with a failed summary instead of leaving sent chunks to the host's
timeout. Stop/cancellation clears pending requests and partial buffers. Capture
failures keep the runtime quiescent for explicit Retry/Discard;
a stopped or unresponsive Worker cannot provide a guaranteed retained result.
