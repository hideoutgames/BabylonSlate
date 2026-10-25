# Bridge Protocol

Main thread ↔ game worker transport: snapshot buffer layout, channels, scene-load handshakes, backpressure and session admission.

## Ownership

- Protocol types and buffers: [`packages/bridge/src/`](../../../packages/bridge/src/) (`layout.ts`, `snapshot-buffer.ts`, `seq-lock.ts`, `transferable.ts`, `channels.ts`, `command-batch.ts`, `simulation-capture.ts`).
- Worker: [`packages/runtime/src/worker-entry.ts`](../../../packages/runtime/src/worker-entry.ts) (`@haptic/runtime/worker-entry`). In-process fallback: `createInProcessRuntime` ([`driver.ts`](../../../packages/runtime/src/driver.ts)).
- Hosts: `createGameWorkerHost` ([`apps/editor/src/services/game-worker-host.ts`](../../../apps/editor/src/services/game-worker-host.ts)), `createPlayerWorkerHost` ([`apps/player/src/worker-host.ts`](../../../apps/player/src/worker-host.ts)). Session: [`apps/editor/src/services/play-session.ts`](../../../apps/editor/src/services/play-session.ts), `GameSessionOwner` ([`game-session-owner.ts`](../../../apps/editor/src/services/game-session-owner.ts)).
- Input capture is owned by `@haptic/input`; the correlated session-boundary client is in bridge.

## Transports

| Path | Mechanism |
| --- | --- |
| Worker → main (every Play and player session; the only production path) | Copy the published snapshot into a recycled `ArrayBuffer` and transfer it. Never require SAB. |
| Inside the runtime (driver's published double buffer) | `SharedArrayBuffer` + `Atomics` seq-lock when available, plain `ArrayBuffer` otherwise. |

- Both share one `Float32Array` layout. Main-thread SAB reads are not wired (optional optimisation; CI exercises transferables).
- No RPC / Comlink: typed control, command, input and snapshot messages only. Results must match between the in-process runtime and the worker path.
- If Worker construction fails, Play falls back to `createInProcessRuntime` and logs a warning.

## Snapshot layout (version 2)

Float indices, little-endian views. `SNAPSHOT_HEADER_FLOATS = 16`, `SNAPSHOT_ACTOR_STRIDE = 16`, `SNAPSHOT_LAYOUT_VERSION = 2`.

| Header float | Field |
| --- | --- |
| 0 | `magic`: `SNAPSHOT_MAGIC_U32 = 0x42534e50` ("BSNP", big-endian u32) stored as f32 bits |
| 1 | `version` (2) |
| 2, 3 | `frameId`, `tickIndex`: raw u32 bits (exact past 2^24) |
| 4 | `actorCount` |
| 5, 6 | `scriptMs`, `physicsMs` of the last publishing tick |
| 7 | `seq` (raw u32 bits; even = stable) |
| 8 | `layoutGeneration` |
| 9–11 / 12–14 | Origin high floats / origin residuals |
| 15 | Origin generation |

Actor slot `i` starts at `16 + i * 16`: `slotId` (0), position xyz (1–3), rotation quaternion xyzw (4–7), scale xyz (8–10), `flags` (11: `SNAPSHOT_FLAG_VISIBLE = 1`, `SNAPSHOT_FLAG_OVERLAY = 2` for SceneLayer actors), position residual (12–14), reserved (15).

- Guids never travel in the hot buffer: guid ↔ `slotId` is maintained on the command channel (`spawn` / `despawn`). Slot ids are dense and recycled; interpolation matches `slotId`, not row index.
- Positions are relative to a camera-selected 1024-unit origin cell (`snapshot-publisher.ts`); readers reconstruct world coordinates before interpolating, so an origin change cannot jump.
- `maxActors` is an initial allocation, not an Actor limit. Growth allocates a complete replacement pair, sends `snapshotLayout { capacity, generation }`, and waits for `snapshotLayoutAck` before publishing. Receivers ignore frames from non-installed generations.
- Copies carry only `snapshotActiveFloatCount` (header + `actorCount` rows). Buffers are not zero-filled: **never read past `actorCount`**.
- `isPublishedSnapshot` requires magic + version. A zeroed spare is "unpublished", not "0 actors" (treating it as empty would despawn every mesh).
- `SNAPSHOT_FLAG_VISIBLE` mirrors the runtime `visible` variable per actor; a hidden parent does not hide a separately rendered child.
- Structural and resource changes never go through the snapshot buffer.

Seq-lock: writer sets `seq` odd, writes header + rows, sets `seq` even; reader samples `seq`, copies, re-reads, retries (bounded) when odd or changed.

## Channels

- `BridgeHostMessage` (main → worker): `control`, `input` (tick-stamped ring), `snapshotLayoutAck`, `recycleSnapshot`.
- `BridgeWorkerMessage` (worker → main): `command`, `commands` (ordered batch), `snapshot` (+ `generation`).
- Control and command payload types are the unions in [`channels.ts`](../../../packages/bridge/src/channels.ts); do not duplicate them here.
- Input is stamped with the last snapshot header `tickIndex` (`snapshotTickIndex`), never with `stats`. `stats` is ~5 Hz (`STATS_COMMAND_INTERVAL_MS` = 200, `@haptic/debugger`) and not a hot path.
- `loadScripts` registers classes without creating Actors; explicit `spawn` requests are filtered by `shouldSpawnScriptedActor` so GameInstance, FunctionLibrary, editor utility, SceneLayer and Scene classes never spawn.

## Scene load handshake

- `sceneLoadId` starts at 1 and increases per load, including same-asset reloads. Hosts identify loads by id, not guid equality.
- `sceneLoading { sceneAssetGuid, sceneLoadId }` precedes departure; hosts with `deferSceneLoadingPaint` answer `sceneLoadingPainted` once Loading UI paints (30 s deadline). `activeScene` precedes spawning; `sceneRealized` follows all resource commands; `sceneLoadFailed` never releases readiness; it reaches the Play Engine, which ends the load's instance compile hold ([render.md](render.md)).
- With `deferSceneModelsReady`, On Scene Finish Loading waits for `sceneModelsReady` with the exact pending guid **and** load id (assignments, textures, shader warm-up, first frame). Stale or post-Stop acks complete nothing.
- Cooperative loading (`cooperativeSceneLoading`, editor Play and player): chunks yield after an 8 ms budget or 256 steps ([`scene-realization-work.ts`](../../../packages/runtime/src/scene-realization-work.ts)); one actor's setup is indivisible. Departing objects and bodies retire before replacements exist. Game Instance keeps ticking; actors, components, physics, animation and BT stay suspended until the readiness ack. Partial preparations publish no snapshots.

## Worker batching and backpressure

- Plain commands batch into one `commands` post. The queue flushes at the end of each message handler and tick, in error handlers, and **before every other post**, so poses never overtake earlier commands. Batching clones at flush, so emitted payloads must not alias state mutated later in the pump: copy at the emit boundary.
- Hosts dispatch a batch through `dispatchCommandBatch`: a throwing handler does not skip the rest.
- Deformer and component transform writes made during a tick are coalesced per actor (`RenderCommandEmitter.queueDeformers` / `queueComponentTransforms`) and sent once, from the actor's state at the end of the tick, before the tick's pose. Writes outside a tick (Inspector edits, host calls between ticks) send at once.
- Snapshots use `TransferablePingPong`: hosts return buffers with `recycleSnapshot` (in a `finally`); spare pool `MAX_FREE_BUFFERS = 2`; at `MAX_IN_FLIGHT_SNAPSHOTS = 2` the worker skips the pose and publishes the newest when a buffer returns. Poses are latest-state; nothing else rides on them.
- Graph debugger views (`debugRoster`, `executionTrace` and a followed Behaviour Tree's `btState`, all answering `debugObserve`) are sent only while the editor observes a target and follows an instance, once per tick at most, and are neither render commands nor part of the command revision ([debugger.md](debugger.md#simulation-graph-debugging)).
- Realized markers (`sceneRealized`, `sceneLayerRealized`, `sceneStreamRealized`) and `runtimeInspectorResult` mutation replies are held until the next pose is sent, so a paused host never redraws an older pose.
- Hosts copy one snapshot per `advance()` catch-up burst; Step and readiness publishes write immediately.

## Sessions and Stop

- `GameSessionOwner` admits one session: mode `play` | `simulate` | `preview`, monotonic generation, abort signal. Preparation re-checks the ticket after every await. The next session waits for `PlaySessionResult.released`; an unconfirmed release quarantines admission until reload.
- Worker Stop posts `stop` and keeps the worker (and its save storage server) until `runtimeStopped` or `WORKER_STOP_TIMEOUT_MS` = 3000, then terminates, so End Play saves cannot interleave with the next session. The exported player terminates at Stop.
- A runtime that stops itself (console `quit`) emits `sessionEnded` after its End Play and On Game End work; the worker holds it until its save writes are answered. Editor Play, Simulation and Preview Build then stop through their normal Stop path, and a standalone player stops itself.
- After Stop, editor Play applies no queued commands or snapshots; logs and diagnostics still arrive. Worker uncaught errors emit the same `diagnostic` shape as the in-process `reportError`.
- Simulation (internal, public launch gated): `quiesceSimulation` → host drains render revision → `captureSimulationState` → ordered UTF-8 chunks ≤ 64 KiB + correlated summary, validated before publication. Inspector/trace snapshots are never a fallback. `__hapticSimulationTest` is test-only.
- Runtime inspection: tree ≤ 4096 identities or 512 KiB, ≤ 5 Hz polling while visible; request client bounds 32 pending, 256 KiB total, 64 KiB per value. Writes never create authoring history.
