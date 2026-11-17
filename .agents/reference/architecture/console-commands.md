# Console Commands

Built-in Play/export console command catalog, its principles, host wiring and user command rules. Registry, tiers and parser: [debugger.md](debugger.md).

## Wiring

| Layer | Role |
| --- | --- |
| [`packages/debugger/src/commands.ts`](../../../packages/debugger/src/commands.ts) | `builtinCommands()`, `CORE_COMMAND_NAMES`, `DEBUG_COMMAND_NAMES`, `MAX_TIME_DILATION` (8) |
| [`packages/debugger/src/autocomplete.ts`](../../../packages/debugger/src/autocomplete.ts) | `suggestConsoleCompletions` / `applyConsoleCompletion` |
| [`packages/debugger/src/validation.ts`](../../../packages/debugger/src/validation.ts) | `console.reserved_name`, debug-tier literal warnings |
| [`packages/runtime/src/runtime-console.ts`](../../../packages/runtime/src/runtime-console.ts) | `RuntimeConsole` implements `ConsoleCommandHost` |
| `RuntimeDriver.executeConsoleCommand` | Single entry for console, Preview, `ExecuteConsoleCommand` and worker `{ type: "console" }`. After Stop it refuses every command ("The runtime session has ended") |
| [`apps/editor/src/lib/play-console.ts`](../../../apps/editor/src/lib/play-console.ts) | `playConsoleCommands`: builtins + compiled `script.command` for completion |
| [`apps/editor/src/services/script-compiler.ts`](../../../apps/editor/src/services/script-compiler.ts) | `consoleCommandFromGraph` (user command metadata) |

## Principles

1. Names do what they say: success means the host applied the change or reported the current value, not that a log line was written.
2. Editor Play includes the debug set by default; release exports strip debug implementations.
3. User `DebugCommand` commands stay core and keep their authored names. Do not prefix them or move them to debug.
4. Engine names are reserved (`CORE_COMMAND_NAMES ∪ DEBUG_COMMAND_NAMES`, lowercase, stripped names included). `register` refuses overwrite and the Command Name field shows an inline error. Duplicate user names: last compiled wins.
5. One pause path: console `pause` / `resume` / `step` and overlay buttons share `RuntimeDriver.pause` / `resume` and the overlay step helper. Overlay chrome follows the worker → main `sessionPaused` command.
6. Optional arguments query: setters print the current value when called bare. Bool flags default to on when omitted, except explicit pairs (`pause` / `resume`).
7. `help` is registry-driven. Registering a builtin (plus its name list) or a user class is enough; do not duplicate help strings.

## Core tier (every build)

| Command | Behavior |
| --- | --- |
| `changescene <scene>` | Same path as `ctx.changeScene`; guid or display name from the Play scene library |
| `quality [tier\|reset]` and `quality shadows\|resolution\|textures\|geometry\|water\|postprocessing\|lighting …` | Shared `RenderingQualitySession`; session overrides via `setScalability`; water fields from `WATER_QUALITY_FIELDS`, post-processing effect flags from `POST_PROCESSING_EFFECT_FIELDS`; cleared at next Play |
| `framecap [fps]` | Render cap only; fixed simulation step and input polling unchanged. Initial value from project `playFrameCap` |
| `volume [0..1]` | `setGlobalVolume` (same as the graph node) |
| `quit` | `runtime.stop()`, then a `sessionEnded` command: editor Play ends its session through the Stop path, Preview Build closes, a standalone player stops itself. Also runs from `ExecuteConsoleCommand` |
| `help [name]` | Lists registered commands, user commands included |

## Debug tier

| Command | Behavior |
| --- | --- |
| `pause`, `resume` / `unpause`, `step` | Idempotent; `pause` is never a toggle. `step` = resume → tick → pause |
| `gc` / `gc stats` | `RuntimeObjectLifetime.request()`; `gc stats` prints `formatObjectLifetimeStats` (collectable count, last pass tick, reached, collected, cleared, ms) |
| `slomo [rate]` | `0..8`; every per-tick system uses the step captured at tick start, so a change applies next tick. Traces keep undilated `dt` plus per-frame `timeDilation` |
| `freecam [on\|off]` | Detached debug camera; simulation keeps ticking; pointer/WASD stop feeding the input ring, gamepad still forwards. Off, `changescene` or possess restore. Never writes actor transforms |
| `showfps`, `stat unit\|memory\|draws\|threads`, `lightsdebug` | Open Stats HUD / highlight row; `threads` means bridge traffic, not OS threads |
| `wireframe`, `showbounds` / `actorboundingbox`, `showcollision` / `debugphysics` | Play-scene overlays in the world rendering group (depth-tested). Collision uses `listDebugColliders()`; each physics-enabled Scene Layer draws in its own overlay scene |
| `postprocessing`, `rendertargets` | Cost measurement (the Feature Test Check's Breakdown): the Play handle's `setPostProcessingEnabled` (no stack rebuild when unchanged, since the add-one base turns it off again after every step); `RenderTargetCaptures.setEveryFrameSuspended`, which skips every-frame captures' draws and keeps their outputs, targets and views (manual requests still draw) |
| `discardsamples` | Profile GPU suspect (Engine-wide, `msaa.discard` in the settings fingerprint): after a frame's last write to a multisampled target is resolved, `invalidateFramebuffer` discards its samples ([`sample-discard.ts`](../../../packages/render/src/sample-discard.ts)). Each graph build marks the render pass that draws into each multisampled texture last (`lastSampleWriters`; disabled passes count, so water's "Forward transparent", which reloads the samples, is the last writer, not the objects pass); the Engine's `resolveMultiFramebuffer` is wrapped once (`installSampleDiscard`) and reads the switch at each resolve, so nothing at graph construction depends on it. A colour left unresolved for `MultisamplePresentTask` is discarded after its blit instead |
| `fsrdebug output device\|view` | Profile step (`upscale.output` in the fingerprint): `SceneRendering.fsrOutputAtView` (`setSceneFsrOutputDebug`), part of `effectsKey`, so the view's graph is prepared again. At `view`, a scene view whose backbuffer is larger than its view (Play under Scene Layers, `sceneOutputScale`) gives `SceneEffectsGraph` the view's size as its output size and no output target: FSR upscales and sharpens to the view's size and the output copy (`Scene post-process output`) fills the backbuffer. No effect on a view as large as its output |
| `layerdebug clears on\|off` | Profile step (`layers.clears` in the fingerprint): `SceneLayerCompositor.depthClears`. Off, a layer composited straight over the world renders with `autoClearDepthAndStencil` false, so its `Forward clear` task clears nothing (a depth-and-stencil clear inside the backbuffer's pass, after the output was written). Layers with an output target are unchanged. A layer whose meshes test or write depth then draws against what the frame left: a measurement switch only |
| `heldimage on\|off` | Profile step (`presentation.held` in the fingerprint): the Play view's `Presentation.holdsImage` (`registered-view-admission.ts`). Off, a coherent frame presented directly skips `HeldImageStore.snapshot` (a blit of the default framebuffer at the device's resolution) and releases the held image, so an incoherent frame finds none and the view's own canvas shows through until the next coherent one. Editor views always hold theirs |
| `backbufferdiscard on\|off` | Profile step (`backbuffer.depth` in the fingerprint), Play only: after a coherent frame's last draw into the backbuffer (the Scene Layers), while it is still bound and its pass open, `invalidateBackbufferDepthStencil` ([`backbuffer-invalidate.ts`](../../../packages/render/src/backbuffer-invalidate.ts)) calls `gl.invalidateFramebuffer(FRAMEBUFFER, [DEPTH, STENCIL])`; the context keeps its drawing buffer otherwise. Their contents are undefined afterwards: with `layerdebug clears off` as well, a layer would read them |
| `renderreset graph\|shadows\|idle` | Profile state probe (an action, not a setting: nothing in the fingerprint): the Play view's frame graph built again with nothing changed (`SceneRenderCoordinator.rebuildGraph`), every shadow map, the views' own included, and the atlas released at the next admission and made again in a later Engine frame (`SceneShadowController.resetAllocations`; `shadowAtlasGeneration` grows by one), or no frame rendered for 3 s (`idleUntil` in `create-engine.ts`'s `shouldRenderFrame`) |
| `scenelayers` | Profile GPU suspect (`layers` in the settings fingerprint): off, Play composites no Scene Layer (`layersHidden` in `create-engine.ts`: `syncPlayComposition` and the frame's layer pass skip them), so the backbuffer is the world's size and the device-resolution tail goes |
| `shadowdebug atlasfit off` | The shadow atlas one power of two larger than its tiles ask (within `shadowAtlasEdgeLimit`), admission planned in the fitted edge so the tiles are the same, the growth exempt like a sun's (`ShadowAdmissionBudget.oversizedAtlas`), never past 8192; listed in `shadows.debug` |
| `shadowdebug depthclamp off` | Profile step: `AtlasCascadedShadowGenerator._isReadyCustomDefines` replaces `SM_DEPTHCLAMP 1` with `2` ([`shadow-vertex-clamp.ts`](../../../packages/render/src/shadow-vertex-clamp.ts), which appends that branch to Babylon's `shadowMapVertexMetric` include): each caster vertex's depth is clamped to the cascade's near plane and no depth program writes `gl_FragDepth`. The bias is resolved as unclamped (`shadow-map-factory.ts`). Exact except for a triangle crossing the near plane; listed in `shadows.debug` |
| `shadowdebug farcascades off` | Profile step: `AtlasCascadedShadowGenerator.defersCascade` leaves the cascades after the first two out of a render in odd Engine frames, once each has drawn: `drawIntoTiles` neither clears their tiles nor refreshes their `drawnViews` (receivers sample each tile with the view that drew it), `getCustomRenderList` lists no caster for them, and the render asks for another (`resetRefreshCounter`, recorded partial), so a map that draws on change is whole a frame later. A moving caster's far shadow lags a frame; listed in `shadows.debug` |
| `gpubusy`, `preservebuffer` | Breakdown timing: `gpubusy` starts (restarting) or stops the project Engine's `GpuBusyProbe` ([`gpu-busy-probe.ts`](../../../packages/render/src/gpu-busy-probe.ts); WebGL2 fences polled with `clientWaitSync(sync, 0, 0)`), read as `RenderDiagnostics.gpuBusy`. `preservebuffer` stores `haptic.debug.preserveDrawingBuffer` in `localStorage`; `projectEngineOptions` reads it when the project Engine is created (an editor reload or reopening the project). The Breakdown's A/B switches the same setting through `setPreserveDrawingBufferSetting` across one reload and stores the user's value back ([feature-test.md](../feature-test.md#on-device-check-and-benchmark)) |
| `gpuprobe on\|off\|serial` | Profile GPU probes, one `EngineGpuProbe` per Engine ([`gpu-probe-engine.ts`](../../../packages/render/src/gpu-probe-engine.ts), pure parts in [`gpu-frame-probe.ts`](../../../packages/render/src/gpu-frame-probe.ts)), read as `RenderDiagnostics.gpuProbe`; nothing exists before the first command. `on` (restarting) wraps the context's framebuffer, clear, draw, blit, invalidate, viewport and scissor calls as own properties (`installGlSignature`) and records per Engine frame its passes (a run of work on one draw framebuffer), a structure hash over the ordered pass list without draw counts, the shadow maps redrawn (`shadowAtlasDrawCounts`, `SceneShadowController.refreshCensus`, `shadowAtlasGeneration`) and the raw `requestAnimationFrame` rate; `off` removes the wrappers. `serial` (`SerialFrameProbe`): `shouldRenderFrame` holds every view until a fence and the backpressure markers show the GPU drained, then 8 frames render one at a time, each fenced at every stage change (`frameStageOf` over the draw pass boundaries, `setDrawPassStageListener`; the tail starts at the task `observeDrawPasses` flags, the FSR upscale or the output's writer, `markFrameTail`), then the synthetic load ([`gpu-synthetic-load.ts`](../../../packages/render/src/gpu-synthetic-load.ts)) runs 6 times. A stage's fence waits for the next pass to start (`GlSignatureRecorder.onPassStart`, `SerialProbeHost.deferFence`), so none splits a pass (a capture's own shadow maps draw into the atlas the scene's just drew into); `SerialProbeResult.splits` counts any that did. `off` also releases the synthetic load's target |
| `shownav` / `shownavdebug`, `showpathfinding`, `shownavagent` | Navmesh, crowd paths and agent telemetry from live crowd state |
| `behaviourtreedebug`, `showaudiodebug` | Live BT inspector; DOM voice overlay (not Babylon GUI) that keeps drawing while paused |
| `dumpactors`, `inspect [name\|guid]`, `possess`, `destroyactor`, `dumplog`, `snapshot start\|stop` | Inspect data; possess/destroy by GUID or unique name (ambiguous names fail); trace recording |

The visualization commands stay off the Debug menu; the console arms them.

## Worker → main commands

`sessionPaused`, `setScalability`, `setGlobalVolume`, `setFreeCam`, `setWireframe` / `setShowBounds` / `setShowCollision` / `setShowNav` / `setShowAudioDebug`, `setPostProcessingDebug` / `setRenderTargetCapturesDebug` / `setGpuBusyProbeDebug` / `setPreserveDrawingBufferDebug` / `setDiscardSamplesDebug` / `setSceneLayersDebug` / `resetRenderingDebug`, `setShadowDebug` / `setWaterDebug`, `debugColliders` (one per physics world, tagged `layerId` for layers), `setShowFps` / `setStat`.

## Autocomplete

- Ranks command names exact → prefix → interior → subsequence, then enum values, `on` / `off`, `param=`, defaults, and context lists from `CommandParameter.complete` (`scenes`, `actors`, `commands`).
- Completion replaces the current token and preserves quoting. The debugger stays headless; Play supplies scene keys and live actor names. Preview Build builds its command list and Scene keys from the game manifest ([`console-catalog.ts`](../../../apps/player/src/console-catalog.ts)), so Classes and Scenes that startup did not load still appear.

## Not engine commands

- Game cheats (`god`, `heal`, `give`, `teleport`) belong in user `DebugCommand` classes.
- Parked: a standalone exported-player command line, `screenshot`, `viewmode`, console `spawn` / `kill`, `restart` (`changescene` of the current scene reloads), a toggling `pause`.
