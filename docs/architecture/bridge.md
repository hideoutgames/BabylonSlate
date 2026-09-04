# Bridge protocol (P4)

Shared surface for main-thread ↔ game-worker transport (engineplan §2.1, §2.4, checklist `p4-bridge`). Implementation: `@babylonslate/bridge`.

This is **not** the P3 JSON harness snapshot (`createWorldSnapshot` in `@babylonslate/object-model`). Harness goldens stay JSON; Play and the renderer use the binary layout below.

## Transports

| Path | When | Mechanism |
| --- | --- | --- |
| SAB seq-lock | `crossOriginIsolated === true` | Double-buffered `SharedArrayBuffer` + `Atomics` seq-lock |
| Transferable ping-pong | Otherwise (GitHub Pages without COI, many CI hosts) | Transfer `ArrayBuffer` each frame; never require SAB |

Both paths share the same `Float32Array` layout and channel message types. SAB is an optimisation; CI must exercise transferables.

Cross-origin isolation on Pages uses `coi-serviceworker.js` in `apps/editor/public/` (reload once on first visit).

## Snapshot buffer layout

Double-buffered `Float32Array`. Views are little-endian; header and per-actor slots use float indices (not byte offsets).

### Header (floats 0..15)

| Index | Name | Type meaning |
| --- | --- | --- |
| 0 | `magic` | `0x42534e50` bits as f32 (“BSNP”) |
| 1 | `version` | Layout version (`1`) |
| 2 | `frameId` | Monotonic render/sync frame |
| 3 | `tickIndex` | Last completed simulation tick |
| 4 | `actorCount` | Occupied slots |
| 5 | `scriptMs` | Script phase time for last tick |
| 6 | `physicsMs` | Physics phase time (separate from `scriptMs`; HUD reads the 5 Hz `stats` command, but this header field is per-tick) |
| 7 | `seq` | Seq-lock sequence (even = stable) for SAB |
| 8 | `layoutGeneration` | Installed snapshot-layout generation |
| 9–15 | reserved | Zero |

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
| 12–15 | reserved |

**Actor guid ↔ slotId** is maintained on the reliable command channel (`spawn` / `despawn` / `remap`). Guids never travel in the hot buffer.

`maxActors` is the initial allocation, not a user-visible Actor limit. Dense slot IDs are recycled after despawn, and capacity grows geometrically before an out-of-range ID is assigned. Growth is subject to memory and performance budgets and allocation success; it is not a promise of mathematically unlimited Actors.

Each replacement has a monotonically increasing `layoutGeneration`. The writer allocates a complete replacement pair, sends ordered `snapshotLayout { capacity, generation }`, and waits for `snapshotLayoutAck` before publishing. SAB mode hands off new buffers because an existing `SharedArrayBuffer` cannot be resized portably; transferable mode replaces both ping-pong buffers under the same handshake. The receiver replaces capacity-sized scratch/index storage and ignores frames from every non-installed generation. Writer rows remain `[0, actorCount)` and interpolation matches recyclable `slotId`, not row index.

`SNAPSHOT_FLAG_VISIBLE` reflects the actor's canonical runtime `visible` variable, initially copied from `SerializedActor.visible`. Scripts can change that variable while playing and the next snapshot updates the renderer. Visibility is per actor: a hidden parent does not implicitly hide a separately rendered child actor.

## Channels

| Channel | Direction | Payload |
| --- | --- | --- |
| Control | main → worker | `load` (`sceneAssetGuid`, optional authored `scene`, `seed`, `physicsWorld`, `gravity`, `havokWasmUrl`), `loadScripts`, `loadAnimGraphs`, `loadSprites` (Sprite + Sprite Animation payloads, optional `pixelsPerUnit`), `loadTilemaps` (tilemap + tileset payloads, optional `pixelsPerUnit`), `loadModels` (Model JSON headers plus cooked complex-collision vertices/indices — not the raw GLB), `play`, `pause`, `step`, `stop`, `setPaused`, `console` (`line`), `inspect`, `sceneLayerResize` (`frustumWidth` / `frustumHeight`, optional `canvasWidth` / `canvasHeight` for Project Cursor NDC) |
| Commands | worker → main (ordered) | `spawn`, `despawn`, `assignMesh` (`meshAssetGuid` + `meshKind`, optional `sceneLayerId` for HUD overlay routing, optional `light` / `camera` / `skybox` / `text3d` payloads, optional `parts[]` for extra component meshes with local TRS), `possessCamera` (`slotId`), `setShadowQuality` (`level`: `off`/`512`/`1024`/`2048`), `assignMaterial`, `activeScene` (`sceneAssetGuid` after `changescene` / `ctx.changeScene`, canonical guid even when the call used a display name), `log`, `print` (keyed HUD; not debugger-gated), `debugDraw` (Play wireframes; not debugger-gated), `diagnostic`, `stats`, `animState` (`slotId`, `stateId`, `normalisedTime`, `blendWeights`, optional `clipName` / `clipKind` / `clipAssetGuid` / `justFinished` / `justLooped` / `layers[]`), `playSound` (`assetGuid`, `volume`, `frameId`, optional `emitterActorGuid` / `loop` / `voiceId`), `stopSound` (`voiceId`), `setChannelVolume` (`channelGuid`, `volume`), `setGlobalVolume` (`volume`), `assignParticle` (`slotId`, `actorGuid`, `componentId`, `particleSystemGuid`, optional `play`, optional `sortingLayer` / `orderInLayer`), `setParticlePlaying` (`actorGuid`, optional `componentId`, `playing`), `setRenderResolution` (`width`, `height`; session-only Play framebuffer), `setCursorVisible` (`visible`; Play CSS cursor, default hidden), `consoleResult` (`success`, `output`), `inspectSnapshot` (`tickIndex` + node list, optional `variableTypes`) |
| Input ring | main → worker | Tick-stamped raw events (see `@babylonslate/input`). Play stamps with the last snapshot header `tickIndex` (`snapshotTickIndex`); `stats` is **not** a hot-path channel (~5 Hz) and must not be the stick clock. The driver applies every queued event each tick so a host/worker clock skew cannot drop sticks. |
| Snapshots | worker → main | Hot-path transform buffers (SAB or transferable) |

Structural and resource changes **never** go through the snapshot buffer.

**Stats command:** `{ type: "stats" }` is **not** a hot-path channel. The worker emits it at ~5 Hz (`STATS_COMMAND_INTERVAL_MS` = 200). `scriptMs` / `physicsMs` / `tickIndex` on the snapshot header stay per-tick. Overlay Play and the packaged player stamp input from `snapshotTickIndex`, not from sparse `stats`.

`load` may set `deferSceneModelsReady`. Overlay Play and the packaged player then post `{ type: "sceneModelsReady", sceneAssetGuid }` after `whenEditorModelsReady()` so Game Instance **On Scene Finish Loading** waits for mesh/model instantiation. Headless in-process tests omit the flag so finish is synchronous. Runtime emits `activeScene` before spawn; the host reloads and resets audio/particles only when the guid differs from the scene already on the handle.

`loadScripts.spawn` is filtered with `shouldSpawnScriptedActor` so `GameInstance`, `FunctionLibrary`, `EditorUtilityObject`, `EditorFunctionLibrary`, `SceneLayer`, and `Scene` never become Actors.

## Typed RPC

Hand-rolled request/response over the control channel (`id`, `method`, `params` / `result` / `error`). No Comlink on the hot path.

## In-process host

`createInProcessBridge()` runs the same protocols on the calling thread for the deterministic harness. Transport choice is a host option; scenario results must match across in-process, SAB (when available), and transferables.

## Play game Worker

Play prefers a dedicated Worker from `@babylonslate/runtime/worker-entry` (`createGameWorkerHost` in the editor). If Worker construction fails (host/Vite), Play falls back to `createInProcessRuntime` and logs a warning. Both paths share control / input / snapshot / command channels. The `load` message includes the open scene's `physicsWorld` / `gravity` and the vendored `/havok/HavokPhysics.wasm` URL so `loadPhysics()` can construct `HavokPlugin` (3d) or Rapier (2d) instead of staying on the AABB software backend.

Diagnostics: `worker-entry.ts` mirrors the in-process driver's `reportError` on the worker's own uncaught `error` / `unhandledrejection` handlers, emitting the same `diagnostic` command shape (including optional `bodyLine`). `play-session.ts` feeds every `diagnostic` command into a `SessionDiagnosticAggregator` on the main thread (`diagnosticFromCommand`) so the Preview session report is populated for the Worker transport too, not only the in-process fallback. `Log` at Error severity also emits `runtime.log` diagnostics (not only the log ring / Output Log).

### Snapshot buffer recycling (transferable path)

The Worker's per-frame snapshot is produced by `TransferablePingPong` (`packages/bridge`), not a fresh `ArrayBuffer` per tick. The host recycles the consumed buffer back to the worker over a `recycleSnapshot` host message once its synchronous consumer (`SnapshotInterpolator.push`, which copies into an owned ping-pong pair immediately) is done with it, so a warmed-up Play session allocates no new snapshot buffer per frame. A frame with nothing to publish (`copySnapshot` returns `false`) calls `cancelWrite()` to return the buffer to the free pool rather than leaking it. This still layers over `postMessage` transfer per frame; true zero-copy `SharedArrayBuffer` main-thread reads (no message per frame at all) when `crossOriginIsolated` remain unwired — a follow-up, not required for correctness since transferables are the CI-mandatory path.

## Seq-lock (SAB)

1. Writer increments `seq` to odd before writing.
2. Writer copies header + slots, then sets `seq` to even (`magic` + layout version are written here).
3. Reader samples `seq`, copies, re-reads `seq`; if odd or changed, retry (bounded).
4. `tryRead` returns `false` until a buffer has been published. Spare seq-lock slots are zeroed; treating that as `actorCount: 0` would despawn every Play mesh created by `assignMesh` and drop `assignMaterial` records before the first tick. `isPublishedSnapshot` requires header `magic` + layout version. A published snapshot with `actorCount: 0` (empty scene) is still valid.

## Related docs

- [object-model.md](object-model.md) — JSON harness snapshot vs this layout
- [design/perf-budget.md](../design/perf-budget.md) — editor viewport / Play budgets
- [render.md](render.md) — snapshot apply + resource cache (P4)
