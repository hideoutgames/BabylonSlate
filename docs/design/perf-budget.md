# Performance budget — A16 iPad baseline

Target device: **11-inch A16 iPad**, 6 GB RAM, WebGL2, WKWebView. Desktop builds inherit headroom.

Viewport stability measurements distinguish successful canvas copies from draw
attempts. Record the selected frame cap, effective backend, dimensions, render
CPU, preparation/copy time, held frames, graph rebuilds and shadow-admission work
alongside resource churn. Compare identical scenes and quality settings; retain
the existing 30 fps editor default. GPU timers that are unsupported or shared
with another view are not per-viewport GPU measurements.

## Frame and tick

| Metric | Budget | Notes |
| --- | --- | --- |
| Play / interaction | project `playFrameCap` (default 60) | Caps Play/Preview from Project Settings; overlay has no live cap field. P4 e2e does not prove A16 60fps — CI tick budget is `p14-perf-smoke`; device 60fps stays `p1-device-spikes` |
| Visible editor viewport | Engine Settings frame cap (default 30) | Scene + Prefab Preview while on screen |
| Hidden / modal / Play / background | **0 rendered frames** | Freeze the editor loop (§2.4) |
| Warm non-CB document workspaces | **≤ 3** | Active + open Scene tabs + recent (`MAX_WARM_DOCUMENT_WORKSPACES`). Open Scenes always mount and count. Content Browser always mounted |
| Idle inactive chrome tab | Unmount after **2 min** | `DOCUMENT_IDLE_UNMOUNT_MS`; pause clock while app backgrounded |
| Game tick (combined) | &lt; 8 ms | ~5 ms scripts + ~3 ms physics in one worker |
| Draw calls | Low hundreds | Prefer instancing; surface in stats HUD |

## Memory

| Resource | Budget | Notes |
| --- | --- | --- |
| Editor + project open | Engine Settings texture budget (default **2 GB**, on) | LRU trims **unreferenced** entries toward 80% of the budget. 512 MB is an iPad suggestion, not the runtime default. WKWebView kills the tab rather than swapping |
| Overlay Play / player PCM | Engine Settings audio budget (default **256 MiB**, on) | Unpinned decoded clips LRU-evict; AudioV2 buffers dispose on evict. 64 MB is an iPad suggestion. Audio Preview is not this cache |
| Max concurrent voices | Engine Settings (default **32**, 8–128) | Oldest voice stops when over cap |
| Geometry | **512 MB** warn (`GEOMETRY_BYTE_CEILING`) | Accounted Scene GLB verts/indices. HUD Geo High. Not LRU, not Settings. 256 MB iPad suggestion in docs |
| Texture accounting | Self-computed bytes | No `performance.memory` on Safari |

Bytes per texel (unit-tested): RGBA8 = 4, ASTC 4×4 = 1, plus ~⅓ for mipmaps.

## Render rules (agents)

- `adaptToDeviceRatio: false`; resolution via `setHardwareScalingLevel`. The dynamic valve reads a per-view `FramePressureSample` — presented-frame interval (null on skipped/hidden/loading frames, never zero), `scene.render()` CPU, and engine GPU time only when the view is the sole rendering view — and scales down on the 15-sample median of the worst signal, up only on proven presentation + CPU/GPU headroom. Only `playMode` handles (Play overlay, Preview Build, standalone player) report presentation/GPU signals: their frame pacing is meaningful. Free-running editor/prefab viewports feed `scene.render()` CPU only — their presented-frame interval measures host event-loop contention, not frame cost — and the valve falls back to the cost-only headroom rule for them.
- MSAA off on iPad baseline.
- `skipPointerMovePicking: true` on all scenes (touch has no hover).
- Medium requests four 2048 directional cascades and 1024 local maps, with Auto capacity of two local shadow lights. Effective admission can reduce these requests to fit attachment, face/pass, sampler and shared-Engine budgets; see [rendering profiles](../architecture/render.md). Authored post-process stacks default to empty. Engine Settings `postProcessingEnabled` defaults **on** and can skip attaching those stacks in the editor / Play preview without changing the scene or exported games.
- Pause render loop, game worker, and encode queue on `visibilitychange` / app background.
- Visible editor viewports always render at `viewportFrameCap` (default 30); freeze when hidden (zero-size or fully off-screen), obstructed, or a modal is open. IntersectionObserver plus an on-screen rect fallback; continuous-render leases stay refcounted.
- Idle-unmount inactive chrome-tab workspaces after 2 minutes (`p18-inactive-documents`); cap 3 warm non-CB DockViews. **Open Scene tabs always stay mounted** and count toward that cap. P4 freeze is not a substitute for unmount. Remount restores layout / camera / graph viewport.
- Content Browser **grid** is window-virtualised (`p18-content-browser-virtualize`); TreeView already is. Revoke off-screen thumbnail blob URLs.
- Add Node catalog **body** is window-virtualised (`p18-add-node-virtualize`); category sidebar stays unwindowed. Distinct from canvas `p18-graph-virtualize`.
- Output Log and Compiler Results window-virtualise to viewport plus overscan (`p20-log-virtualize`; `WindowedList` / TreeView arithmetic). Ring buffer cap 500 stays. SearchDialog (AssetPicker / ClassPicker) uses the same helper. Place Actors catalogs stay unwindowed. Global Search **result** body is not virtualised.
- One `Engine` per **open project** (hidden constructor canvas). Scene viewport, Play overlay, Material Preview, **and Prefab Preview** are `sharedEngine` clients (`p18-shared-prefab-engine`). Close project disposes Engine + ResourceCache.
- Play/Preview renders at project `playFrameCap` (default 60), not the editor viewport cap.
- Construct textures only through `ResourceCache` (stable blob URL + canonical sampling flags). **One cache per Engine lifetime** (`p20-shared-resource-cache`): Play / Prefab / Material reuse the viewport cache even when `sharedEngine` is set. Each `createEngine` handle pins its `textureBytes` guids (`setClientTextures`); LRU eviction of **unreferenced** entries (not pinned by any handle) trims toward 80% of the Engine Settings ceiling (default 2 GB). `getTexture` accounts sniffed KTX2/PNG sizes.
- Editor idle `freezeActiveMeshes()` / static `freezeWorldMatrix()` / `material.freeze()` / unique-id maps / scene-load `forceCompilationAsync` are **Done** (`p20-editor-scene-freeze`). Visible editor stays at `viewportFrameCap` — do not dirty-skip an on-screen scene. Remount dialog: Collecting Assets → Loading Models → Warming Shaders.
- Play prepare caches compiled scripts by graph content hash and loads Audio `source` chunks on first `playSound` (`p20-play-compile-audio`, **Done**). Overlay Play and `apps/player` share the lazy audio path.
- Global Search rebuilds when the dialog is initiated (`p20-search-on-demand`, **Done**), not on project open. Async/chunked; include open-document JSON. No on-disk search cache.
- No per-actor per-frame allocation in snapshot apply (reuse scratch math objects). `SnapshotInterpolator.push` copies into two owned `Float32Array`s (ping-pong); do not `slice()` a new buffer per snapshot. Each sampled snapshot identity (`frameId`, α, layout generation) applies once per frame even though registered-view admission and the render loop both sample; audio pose/listener sync rides the same apply so capped draws still sync once.
- Play overlay / packaged-player HUD must not `setState` (or rewrite chrome DOM) at 60 Hz. Worker `stats` is ~5 Hz; rAF FPS sampling is 1 Hz. Tick stamp and worker timings also live on the snapshot header.


## CI

`p14-perf-smoke` is in `pnpm verify` (Vitest):

- Tiny in-process scene: `lastScriptMs`, `lastPhysicsMs`, and combined tick `< TICK_BUDGET_MS` (8 ms). Keep the fixture small so GitHub runners stay under budget.
- 120 ticks → `stats` command count is ~5 Hz (not 120); snapshot header `tickIndex` is still 120. 2000 ticks with one looping `AudioComponent`: one `playSound`, `stats` stays ~5 Hz, last-100 median tick cost is not much worse than first-100.
- Accounted texture + geometry bytes vs committed ceilings (`TEXTURE_BYTE_CEILING` 2 GB, `GEOMETRY_BYTE_CEILING` 512 MB). Drift fails CI.
- Obstructed / hidden editor: `RenderScheduler.shouldRender() === false` (zero frames).
- Draw-call ceiling (`DRAW_CALL_WARN_CEILING` 400) as HUD warnings.

A16 60fps and on-device reopen remain `p1-device-spikes`. Export unzip-serve-boot-tick is `e2e/p14-export.spec.ts`.

## Renderer baseline fixtures

`e2e/rendering-baseline.spec.ts` loads a primitive room with sixteen eligible point lights, compares sixteen spots with authored 45°/90° inner/outer cones, and reloads points. Each fixture records 30 seconds of viewport frame intervals and CPU timing, shared-Engine GPU query readings, actual drawing dimensions, capability limits, estimated shadow/texture/geometry bytes, resource churn and real canvas captures. Intervals are an Engine-end-frame presentation proxy; GPU queries may include sibling views or repeat the last completed sample, and sampled churn is a lower bound. `e2e/rendering-transitions.spec.ts` exercises settings close, unchanged close, and explicit reload with blocking loading progress. Run these explicit files through `pnpm --silent agent:wait local --script test:e2e -- <file>` (quote `'--'` in PowerShell).

These are local browser safety and rendering checks. Chromium touch emulation is not Safari/iPad GPU validation, estimated bytes are not measured residency, and short fixture runs do not establish sustained 60 fps. The A16 crash mechanism remains unconfirmed without device evidence.

### Local software-renderer observation

Revision `e6d008c3`, Windows Chromium 151.0.7922.34, WebGL2 through ANGLE/SwiftShader, tracing off. Three 30-second samples rendered at 720×464 with a 30 fps editor cap and eleven of sixteen requested forward lights admitted. GPU timer queries were unavailable.

| Fixture | Frame interval median / p95 / p99 (ms) | Estimated shadow MiB | Shadow faces/passes |
| --- | --- | --- | --- |
| Point | 479.9 / 493.1 / 499.3 | 360 | 48 |
| Spot | 148.6 / 158.0 / 162.6 | 132 | 11 |
| Point repeat | 641.0 / 660.7 / 684.6 | 360 | 48 |

Software rendering stayed far below the viewport cap. Scene-render CPU medians were 3.2/2.1/3.1 ms; that counter does not measure total presentation time. Each sample observed zero texture/render-target churn and one live Engine scene. Engine texture counts were 23/30/24 across fixtures, so this is not proof of constant total resource use. Non-shadow byte counters omit this fixture's runtime primitives and default textures. Setup, including persisted saves, took 35.7/12.9/21.6 seconds before sampling. A16/Safari performance, total GPU residency and sustained thermal behavior remain unmeasured.

### Viewport light-edit comparison

The `scene viewport light-edit performance measurement` case uses four point
lights, two 512-pixel shadow maps and the unchanged 30 fps editor cap. Each run
measures 30 seconds idle and 30 seconds of real Details X edits, with a 500 ms
pause after each commit. Faster inputs therefore complete more edits. Pixel
correctness runs separately. The local native adapter is available through
`--config playwright.perf.config.ts --project=perf-gpu`; select this exact case
in `e2e/rendering-baseline.spec.ts` through the resource-admitted test runner.

On 24 September 2026, the original `225d55b8` production code and fixed
`6061fb2b` (software) / `2c0866f6` (native) used Chromium 151.0.7922.34,
1280×720 CSS, a 720×464 drawing buffer, WebGL2 and identical quality. Both
revisions used the same measurement harness; tracing and video were off.

| Adapter / workload | Original interval median / p95 / p99 (ms) | Fixed interval median / p95 / p99 (ms) |
| --- | --- | --- |
| RTX 2060, idle | 33.44 / 34.12 / 34.91 | 33.45 / 35.27 / 38.05 |
| RTX 2060, editing | 33.41 / 44.22 / 63.36 | 33.44 / 52.63 / 85.36 |
| SwiftShader, idle | 68.94 / 81.65 / 85.86 | 67.27 / 77.87 / 82.24 |
| SwiftShader, editing | 71.13 / 85.09 / 130.37 | 70.22 / 133.21 / 156.73 |

Native editing render-CPU median/p95 changed from 1.52/4.09 ms to 1.34/3.63 ms;
idle median changed from 1.44 to 1.62 ms. Both native runs reached the idle cap
and completed 53 edits; median automated fill-plus-Tab time was 58/54 ms.
Software runs completed 12/21 edits with median input time 1953/799 ms. These
automation timings include browser scheduling and are not direct touch latency.

The fixed version held 126 native and 42 software candidates during editing,
with zero graph builds in either timing window. Interval tails did not improve;
the original draw counter includes candidates the fixed copy counter can reject.
This is a frame-retention and redundant-work correction, not an overall FPS
improvement claim. Synchronous flush/copy time in the fixed editing run was
0.065 ms median on native GPU versus 65.78 ms in software rendering, explaining
why the latter cannot isolate editor CPU performance. Native shadow-admission
work totaled 278 ms over the 30-second edited window; it did not dominate that
workload, so no further admission-cache policy was introduced.

Both revisions retained one Engine scene, 22 meshes, two render targets and
36 MiB of estimated shadow allocations, with zero sampled texture/target churn.
The [measurement record](../assets/renderer-qualification/2026-09-24-viewport-stability/measurements.json)
contains settings, counters and distributions. These single local observations
do not establish iPad/Safari performance, isolated GPU time or thermal behavior.

### Camera-driven shadow activation

The targeted `Shadow activation handoff` cases in `e2e/framegraph-shadows.spec.ts`
measure first and repeated camera-driven point-shadow promotions in PBR and CEL
with the shared allocation ceiling fixed to one cube. Reports include preparation
time, graph build count, selected light and reserved bytes. Run the exact cases
on the same native GPU and settings before comparing revisions; software rendering
establishes correctness, not device performance.

On the native RTX 2060 / ANGLE D3D11 WebGL2 fixture (96×72, one 256-pixel cube,
4.5 MiB allocation ceiling), `47d945c7` rebuilt the graph on every handoff:
first transitions took 221–342 ms, repeated transitions 56–84 ms. At `31f188d7`,
stable graph tasks eliminated every handoff build; first transitions took
128–157 ms and repeated transitions 23–28 ms. Both PBR and CEL retained exactly
one allocation within the same ceiling. These are small-fixture preparation
times, not a claim about frame times in a large saved scene; cold receiver
compilation remains visible and needs separate treatment.

The staged-handoff route subsequently records total activation time, frame count,
maximum preparation time and maximum CPU render duration while continuing to draw
the incumbent. This route omits synchronous pixel readback during timing; the
separate parity cases retain the native pixel oracle. Preparation latency and
blocking frame work are distinct measurements.

At `27b2d432` on the same native GPU, staged PBR/CEL WebGL2 activation completed
over 12/10 rendered frames (231/176 ms total). Their longest preparation calls
were 25.6/22.5 ms and longest CPU render calls 29.8/8.0 ms. Other handoffs spent
23–38 ms in their longest preparation call. Native WebGPU's first PBR/CEL handoffs
took four rendered frames, with longest preparation calls of 24.1/22.0 ms and
CPU render calls of 21.7/10.3 ms. Both backends compiled their two cold receiver
variants during warmup, with zero compilations during activation preparation or
subsequent handoffs. All handoffs retained zero graph rebuilds and one allocation
within the same ceiling. A driver call can exceed the dispatch time budget; these
small-scene measurements do not establish large-scene or mobile frame-time bounds.

### Static shadow reuse comparison

A later run at `1b575657` uses the same fixture, browser version, software backend, dimensions, cap, and three 30-second untraced samples. Other local agent checks were held during both runs. The reference at `fc735530` predates static caching and nearest-light selection; this is a revision comparison, not an isolated attribution of each change.

| Fixture | Reference median / p95 / p99 (ms) | Cached median / p95 / p99 (ms) | Cached interval samples | Estimated shadow MiB |
| --- | --- | --- | --- | --- |
| Point | 484.7 / 510.3 / 541.4 | 67.6 / 82.2 / 91.7 | 435 | 360 |
| Spot | 163.3 / 178.2 / 189.4 | 143.9 / 168.9 / 175.0 | 203 | 132 |
| Point repeat | 652.6 / 665.4 / 670.8 | 205.3 / 293.9 / 313.8 | 135 | 360 |

Settled captures reported zero shadow draws while keeping 48/11/48 allocated shadow faces and 8/11/8 render targets. Shadow memory did not shrink. CPU medians were 1.16/1.28/1.24 ms; setup including saves took 6.9/10.3/15.0 seconds. Every sample retained one Engine scene and observed zero sampled texture/target churn; texture counts remained 23/30/24. The slower repeated point fixture remains unexplained by these counters. These results do not establish hardware GPU time, leak freedom, iPad performance, or a 60 fps result.

### Play performance route (revision comparison)

`e2e/play-performance-route.spec.ts` is an opt-in local route (`BL_PERF_ROUTE=1`): a deterministic primitive room (floor, three walls, 96 static casters, 16 dynamic spheres, sun plus six shadow-casting point lights and two spots, default skybox) is loaded into the minimal test project with the selected quality profile, overlay Play starts, and after a 10-second warm-up the page's `requestAnimationFrame` cadence, `longtask` entries, runtime tick rate, heap and canvas size are sampled twice for 30 seconds. Run it through the owned server with `playwright.perf.config.ts`: `BL_PERF_ROUTE=1 BL_PERF_QUALITY=low pnpm run test:e2e e2e/play-performance-route.spec.ts --config playwright.perf.config.ts --project perf-gpu` (`perf-gpu` = full Chromium headless on this machine's adapter through ANGLE D3D11; `perf-software` = the ordinary SwiftShader project). `BL_PERF_PROFILE=1` additionally records a V8 CPU profile of steady-state Play. It never asserts a frame rate.

Observation at the pre-overhaul merge `f2fcbdc6` versus `main` `f30f5391`, Windows Chromium 151.0.7922.34, NVIDIA GeForce RTX 2060 (ANGLE D3D11), 1280×720 CSS viewport, headless, same route and profiles (second 30-second sample):

| Revision | Quality | Canvas | Average fps | Interval median / p95 / p99 (ms) | Stalls > 33 ms | Long tasks (count / ms) |
| --- | --- | --- | --- | --- | --- | --- |
| `f2fcbdc6` | Low | 1280×720 | 59.4 | 16.7 / 16.8 / 17.0 | 7 | 0 / 0 |
| `f30f5391` | Low | 960×540 | 7.1 | 133.8 / 150.6 / 167.2 | 214 | 214 / 29687 |
| `f2fcbdc6` | Medium | 1280×720 | 56.3 | 16.7 / 33.4 / 33.5 | 56 | 0 / 0 |
| `f30f5391` | Medium | 960×540 | 7.3 | 133.8 / 150.5 / 167.2 | 218 | 218 / 29560 |

The runtime ticked at 60 Hz in every run; the regression is main-thread render admission, not the worker. An 8-second CPU profile of `main` Play spent 74% of sampled time under the coordinator's per-frame strict readiness (`Scene.isReady` → `PBRMaterial.isReadyForSubMesh` → `_prepareEffect` / `MaterialDefines.rebuild`, plus shadow-map `isReadyForRendering` → caster readiness); Babylon's readiness probes toggle `Light.shadowEnabled`, which marks every mesh light-dirty, so each frame re-prepared every material's defines. Dynamic resolution dropped the canvas to 960×540 without recovering because the cost is CPU-bound. This is a local desktop observation, not A16, Safari or thermal qualification; SwiftShader runs of the same route are GPU-bound (1.4 fps pre-overhaul, 3.2 fps main) and do not isolate the CPU cost.

Recovery measurement with the readiness-admission cache (#633, measured on its branch before merge), same machine, route, Low quality, browser and adapter: the two 30-second samples averaged 59.6 and 59.8 fps, interval median 16.72 ms, p95 16.9 ms, p99 17.0 ms, longest 33.5 ms, 4 and 1 stalls over 33 ms, zero long tasks, runtime tick 60.0 Hz, canvas back to 1280×720. The pre-overhaul reference on the same route was 59.4 fps with a 16.72 ms median. CEL-mode and post-#638/#640 runs are pending a machine with enough free memory for the route (`BL_PERF_RENDER_MODE=cel` selects CEL).

The sustained variant — 20-minute post-warm-up windows through Play **and** Preview Build with per-window diagnostics — is `e2e/play-sustained-route.spec.ts` (`BL_PERF_SUSTAINED=1`, same `playwright.perf.config.ts` projects). The full coverage matrix, procedure, adapter caveats and acceptance thresholds live in [renderer-qualification.md](renderer-qualification.md).
