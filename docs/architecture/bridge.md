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
| 6 | `physicsMs` | Physics phase time (separate from `scriptMs`; full 5 Hz HUD is P8) |
| 7 | `seq` | Seq-lock sequence (even = stable) for SAB |
| 8–15 | reserved | Zero |

### Per-actor slot

`SNAPSHOT_HEADER_FLOATS = 16`, `SNAPSHOT_ACTOR_STRIDE = 16`.

Slot `i` starts at `16 + i * 16`:

| Offset | Name |
| --- | --- |
| 0 | `slotId` (dense integer id as f32) |
| 1–3 | `position` xyz |
| 4–7 | `rotation` quaternion xyzw |
| 8–10 | `scale` xyz |
| 11 | `flags` (bit 0 = visible) |
| 12–15 | reserved |

**Actor guid ↔ slotId** is maintained on the reliable command channel (`spawn` / `despawn` / `remap`). Guids never travel in the hot buffer.

Capacity is fixed at create time (`maxActors`). Writer fills slots `[0, actorCount)`; reader interpolates the two most recent stable buffers by `slotId`, not array index. New slots copy their latest pose immediately and removed slots disappear, so a spawn/despawn reorder cannot blend unrelated actors.

## Channels

| Channel | Direction | Payload |
| --- | --- | --- |
| Control | main → worker | `load` (`sceneAssetGuid`, optional authored `scene`, `seed`, `physicsWorld`, `gravity`, `havokWasmUrl`), `loadUserInterfaces` (`documents[]`: `{ guid, widgets: { id, kind, name?, nestedUiGuid? }[] }` — slim metadata only; does not apply a HUD), `uiWidgetEvent` (`instanceId`, `widgetId`, `kind`: `click` \| `value` \| `checked` \| `text` \| `pointerEnter` \| `pointerExit` \| `pointerDown` \| `pointerUp`, optional `value`; `/`-prefixed `widgetId` routes to a nested UI instance), `loadScripts`, `loadAnimGraphs`, `loadSprites` (Sprite + Sprite Animation payloads, optional `pixelsPerUnit`), `loadTilemaps` (tilemap + tileset payloads, optional `pixelsPerUnit`), `play`, `pause`, `step`, `stop`, `setPaused`, `console` (`line`), `inspect` |
| Commands | worker → main (ordered) | `spawn`, `despawn`, `assignMesh` (`meshAssetGuid` + `meshKind`, optional `light` / `camera` payloads, optional `parts[]` for extra component meshes with local TRS), `possessCamera` (`slotId`), `setShadowQuality` (`level`: `off`/`512`/`1024`/`2048`), `assignMaterial`, `activeScene` (`sceneAssetGuid` after `changescene` / `ctx.changeScene`, canonical guid even when the call used a display name), `log`, `diagnostic`, `stats`, `uiApply` (`instanceId`, `classId`, `assetGuid`), `uiRemove` (`instanceId`), `uiSetVisible` (`instanceId`, `widgetId`, `visible`), `setInputMode` (`mode`: `All` \| `Interface` \| `Game`; default **All**; Play stop / player boot reset), `animState` (`slotId`, `stateId`, `normalisedTime`, `blendWeights`, optional `clipName` / `clipKind` / `clipAssetGuid` / `justFinished` / `justLooped` / `layers[]`), `playSound` (`assetGuid`, `volume`, `frameId`, optional `emitterActorGuid` / `loop` / `voiceId`), `stopSound` (`voiceId`), `setChannelVolume` (`channelGuid`, `volume`), `setGlobalVolume` (`volume`), `assignParticle` (`slotId`, `actorGuid`, `componentId`, `particleSystemGuid`, optional `play`), `setParticlePlaying` (`actorGuid`, optional `componentId`, `playing`), `setRenderResolution` (`width`, `height`; session-only Play framebuffer), `consoleResult` (`success`, `output`), `inspectSnapshot` (`tickIndex` + node list, optional `variableTypes`) |
| Input ring | main → worker | Tick-stamped raw events (see `@babylonslate/input`). Play stamps with the last worker `stats.tickIndex`; the driver applies every queued event each tick so a host/worker clock skew cannot drop sticks. |
| Snapshots | worker → main | Hot-path transform buffers (SAB or transferable) |

Structural and resource changes **never** go through the snapshot buffer.

**UserInterface boot order:** `load` → `loadUserInterfaces` → `loadScripts` (and other content) → `play`. Widget metadata must be registered before a script can Apply. Hosts send `uiWidgetEvent` on the control channel after apply; the worker does not invent widget input. `uiApply` / `uiRemove` / `uiSetVisible` are ordered commands — apply before visibility, remove after teardown. Overlay Play (`playSessionBootControls`) and the packaged player (`packedBootControls`) share this order. `loadScripts.spawn` is filtered with `shouldSpawnScriptedActor` so `UserInterface:<guid>` never becomes an Actor. `setInputMode` is session-scoped: **All** until a graph calls **Set Input Mode**; stop/boot restores **All**. Live editor EUI does not consume this command. See [input.md](input.md) and [ui-runtime.md](ui-runtime.md).

## Typed RPC

Hand-rolled request/response over the control channel (`id`, `method`, `params` / `result` / `error`). No Comlink on the hot path.

## In-process host

`createInProcessBridge()` runs the same protocols on the calling thread for the deterministic harness. Transport choice is a host option; scenario results must match across in-process, SAB (when available), and transferables.

## Play game Worker

Play prefers a dedicated Worker from `@babylonslate/runtime/worker-entry` (`createGameWorkerHost` in the editor). If Worker construction fails (host/Vite), Play falls back to `createInProcessRuntime` and logs a warning. Both paths share control / input / snapshot / command channels. The `load` message includes the open scene's `physicsWorld` / `gravity` and the vendored `/havok/HavokPhysics.wasm` URL so `loadPhysics()` can construct `HavokPlugin` (3d) or Rapier (2d) instead of staying on the AABB software backend.

Diagnostics: `worker-entry.ts` mirrors the in-process driver's `reportError` on the worker's own uncaught `error` / `unhandledrejection` handlers, emitting the same `diagnostic` command shape (including optional `bodyLine`). `play-session.ts` feeds every `diagnostic` command into a `SessionDiagnosticAggregator` on the main thread (`diagnosticFromCommand`) so the Preview session report is populated for the Worker transport too, not only the in-process fallback. `Log` at Error severity also emits `runtime.log` diagnostics (not only the log ring / Output Log).

### Snapshot buffer recycling (transferable path)

The Worker's per-frame snapshot is produced by `TransferablePingPong` (`packages/bridge`), not a fresh `ArrayBuffer` per tick. The host recycles the consumed buffer back to the worker over a `recycleSnapshot` host message once its synchronous consumer (`SnapshotInterpolator.push`, which copies immediately) is done with it, so a warmed-up Play session allocates no new snapshot buffer per frame. A frame with nothing to publish (`copySnapshot` returns `false`) calls `cancelWrite()` to return the buffer to the free pool rather than leaking it. This still layers over `postMessage` transfer per frame; true zero-copy `SharedArrayBuffer` main-thread reads (no message per frame at all) when `crossOriginIsolated` remain unwired — a follow-up, not required for correctness since transferables are the CI-mandatory path.

## Seq-lock (SAB)

1. Writer increments `seq` to odd before writing.
2. Writer copies header + slots, then sets `seq` to even (`magic` + layout version are written here).
3. Reader samples `seq`, copies, re-reads `seq`; if odd or changed, retry (bounded).
4. `tryRead` returns `false` until a buffer has been published. Spare seq-lock slots are zeroed; treating that as `actorCount: 0` would despawn every Play mesh created by `assignMesh` and drop `assignMaterial` records before the first tick. `isPublishedSnapshot` requires header `magic` + layout version. A published snapshot with `actorCount: 0` (empty scene) is still valid.

## Related docs

- [object-model.md](object-model.md) — JSON harness snapshot vs this layout
- [design/perf-budget.md](../design/perf-budget.md) — editor viewport / Play budgets
- [render.md](render.md) — snapshot apply + resource cache (P4)
