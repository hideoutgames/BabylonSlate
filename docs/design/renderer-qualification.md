# Renderer qualification

## Engine follow-up: deferred local verification

On 2026-09-22 the user requested skipping checks that cannot fit the machine's available memory and recording them for later. The team's queued particle check was cancelled before execution; no running check or unrelated process was stopped. `BL_TEST_PROFILE=shared` remains required. The shared `local-resources.json` had a 3 GiB reserve at deferral and changed externally to 2 GiB during source integration; this team left it unchanged. Read the current shared configuration when resuming. Do not bypass admission or repeatedly queue these checks while they cannot fit.

Physical A16 verification is waived for this follow-up. Local browser/native verification is deferred where listed below, not counted as passed. No desktop or software-WebGPU result establishes device performance. Required CI and merge gates remain unchanged.

| Delivery | Recorded source/evidence | Pickup |
| --- | --- | --- |
| A: snapshot synchronization | `3d0031bd`, `t3code/engine-ownership-performance`. Four explicit unit files passed 192 cases at `ba76a60f`; scoped render typecheck/lint passed. Two desktop Play/Preview pixel cases passed at `2c1f29ae`. Snapshot-attributable global dirty/cleanup counts fell from 120 per 120 samples to zero. | No local check was deferred for A. [PR #657](https://github.com/hideoutgames/BabylonSlate/pull/657) remains unmerged, awaiting the normal Verify slot and current-head CI. |
| B: native physics lifecycle | `82ae49a0`, `agent/engine-physics-lifecycle-b`. Earlier real-Havok removal/resource cases passed, but the immediate teleport ray failed and a compound trigger case hung before the latest corrections. Those corrections are unverified. | Resume the isolated native trigger and teleport/constraint/controller cases first, then the explicit lifecycle/transaction files, affected Rapier/runtime callers and scoped static checks. Keep native detachment/teleport gates open. |
| C: dirty physics preparation | Frozen baseline fixture `de96b6d3`, `agent/engine-physics-dirty-c`; implementation is on a separate branch. The new five-case preparation fixture has not run. | Run `packages/runtime/src/physics-sync-preparation.test.ts` at the frozen baseline before comparing the implementation. Validate native B before treating C as deliverable. |
| D: texture leases and stable sprites | Source `b8a11880`, notes `5fe391b3`, `agent/engine-texture-leases-d`. Earlier batch: 68 passed, 7 failed. Fixture repairs and subsequent upload/admission fixes are unverified; the earlier typecheck at `0e675860` does not certify the current head. | [Exact unit, editor, static and browser commands](https://github.com/hideoutgames/BabylonSlate/blob/5fe391b36d555041c4e79bbcca2def0c4a152c7c/docs/architecture/render.md#texture-ownership-verification-pickup). Includes the 10,000-selection WebGL2/WebGPU fixture. |
| E: model/text visual lifetimes | Source `64599304`, notes `233b75ba`, `agent/engine-visual-lifecycle-e`. Baseline: 5 failures/6 passes; implementation at `e36439b1`: 18/18 in the same two files. Later editor staging, multipart budgets and additional ownership changes are unverified. | [Exact segmented native/consumer/browser commands](https://github.com/hideoutgames/BabylonSlate/blob/233b75ba/docs/architecture/render.md#visual-ownership-verification-pickup), plus scoped static checks. Combine the AssetContainer and physics patch hunks before final integration verification. |
| F: particles | `79a00663`, `agent/engine-particles-f`. 49 cases passed across earlier checkpoints. Two follow-up cases at `150ee60a` were cancelled while queued, with no execution. Later clock-ordering, D integration and browser changes are unverified. | [Particle pickup commands and evidence](https://github.com/hideoutgames/BabylonSlate/blob/79a006630853b990d971a5e805ac70e1382771ed/docs/architecture/particles.md). Resume the two selected lifecycle cases, scoped render/editor checks and four CPU/GPU × WebGL2/WebGPU browser cases. Particle-specific exported-player lifecycle verification remains open. |

The first native-physics probes, from the B worktree, are deliberately bounded and sequential:

```powershell
$env:BL_TEST_PROFILE = 'shared'
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'ends retired trigger' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'teleports falling|keeps constraints|retains controller|defers contact' --disableConsoleIntercept
```

Before resuming, compare the working head with the recorded checkpoint and select checks affected by intervening source, dependency or configuration changes. Keep failed, cancelled and unexecuted results separate from passes. Record exact source, command, backend and resource/operation counts for each resumed batch. B–F have no delivery PR yet; the work remains unmerged and is not verified complete.

Status: **tooling landed, runs pending.** The sustained route (`e2e/play-sustained-route.spec.ts`, `BL_PERF_SUSTAINED=1`) enumerates on CI and skips without the env flag; no machine with enough free memory has completed a full session yet. Nothing on this page is A16/iOS PWA qualification — desktop Chromium observations only. Budgets live in [perf-budget.md](perf-budget.md); the engine-level design is in [render.md](../architecture/render.md).

## Coverage matrix

"CI" means the standard e2e suite (Chromium, SwiftShader/software WebGPU via `SOFTWARE_WEBGPU_ARGS`). "Local-only (env gate)" specs enumerate but skip without their flag. "Unit" means Vitest coverage with no browser run.

### Backend

| Backend | Coverage |
| --- | --- |
| WebGL2 | Default for the whole suite; explicit packed/proof runs in `color-pipeline.spec.ts`, `framegraph-forward.spec.ts`, `framegraph-post-process.spec.ts`, `framegraph-post-process-lifetime.spec.ts`, `player-backend.spec.ts`, `webgpu-backend.spec.ts` (transitions include WebGL2 legs) |
| WebGPU | `color-pipeline.spec.ts`, `framegraph-forward.spec.ts`, `framegraph-post-process.spec.ts`, `framegraph-post-process-lifetime.spec.ts`, `framegraph-shadows.spec.ts`, `scene-post-process-coordinator.spec.ts`, `player-backend.spec.ts`, `webgpu-backend.spec.ts`, `webgpu-previews.spec.ts`, `environment-lighting-webgpu.spec.ts`, `baked-parity.spec.ts` — all through software WebGPU on CI |

### Render path

| Path | Coverage |
| --- | --- |
| `forward` | `framegraph-forward.spec.ts` (opt-in graph preserves surface pixels and ownership, both backends); `clustered-path-selection.spec.ts` (explicit forward request) |
| `clusteredForward` | `clustered-lights.spec.ts` (native and graph PBR/CEL pixels, WebGL2); `clustered-lights-webgpu.spec.ts` (same parity under WebGPU storage-buffer masks); `clustered-path-selection.spec.ts` (editor selection, Play, packed player Auto→clustered) |
| `auto` | `clustered-path-selection.spec.ts` (auto resolves `clusteredForward` in editor, Play and packed player; session `renderpath` request is global and non-persistent); `render-path-settings.spec.ts` (project-wide pipeline settings retained through reopen) |

### Style

| Style | Coverage |
| --- | --- |
| PBR | Default everywhere |
| CEL | `cel-render-mode.spec.ts`, `cel-hard-steps.spec.ts` (both backends), `cel-shadow-lifecycle.spec.ts`, `clustered-lights.spec.ts`, `clustered-lights-webgpu.spec.ts` (clustered CEL tie sequence under WGSL), `framegraph-forward.spec.ts` (pbr and cel captures), `baked-parity.spec.ts`, `webgpu-backend.spec.ts` (WebGPU CEL proof) |

### Features

| Feature | Coverage |
| --- | --- |
| Shadows | `shadow-refresh.spec.ts`, `cel-shadow-lifecycle.spec.ts`, `framegraph-shadows.spec.ts`, `webgpu-backend.spec.ts` (WebGPU shadow proof), `rendering-baseline.spec.ts` (shadow passes/bytes) |
| Project post-processing effects | `color-pipeline.spec.ts` (bloom/effects chain in packed WebGL2 + WebGPU player and editor viewport) |
| Authored post-process stack | `framegraph-post-process.spec.ts`, `framegraph-post-process-lifetime.spec.ts`, `scene-post-process-coordinator.spec.ts`, `scene-post-process-host.spec.ts`, `post-process-owner-overrides.spec.ts` |
| Baked lighting | `baked-parity.spec.ts` (synthetic-atlas PBR/CEL parity, dielectric + metallic environment specular/diffuse cells on both backends), `baked-player.spec.ts` (Preview Build), `baked-play.spec.ts` (Editor Play + served export, zero realtime light defines on applied receivers), `baked-runtime.spec.ts`; authoring side `scene-bake.spec.ts`, `scene-bake-job.spec.ts`, `bake-provider.spec.ts`, `bake-uv.spec.ts` — the quality-tier bake variants are local-only (`BL_BAKE_QUALITY_E2E=1`) |
| SceneLayers | `scene-layer-rendering.spec.ts` (viewport + Play); `runtime-owner-continuity.spec.ts` (moving global layer retained across loading, Play + Preview Build) |
| Particles | `p17-particles.spec.ts` (authored emitter/system, Play billboards, teardown, save/reopen) |

### Hosts

| Host | Coverage |
| --- | --- |
| Editor viewport | `viewport-shading.spec.ts`, `cel-render-mode.spec.ts`, `rendering-baseline.spec.ts`, `color-pipeline.spec.ts` (bloom), `webgpu-backend.spec.ts`, `viewport-guides.spec.ts` |
| Play | `p4-play.spec.ts`, `qa-animation-overlap.spec.ts`, `tilemap-rendering.spec.ts`, `qa-play-controls.spec.ts`, `play-debug-console.spec.ts`, `runtime-owner-continuity.spec.ts`, `scene-layer-rendering.spec.ts`, `clustered-path-selection.spec.ts` |
| Preview Build | `p14-preview-build.spec.ts`, `baked-player.spec.ts`, `tilemap-rendering.spec.ts`, `runtime-owner-continuity.spec.ts`, `clustered-path-selection.spec.ts` (packed player) |
| Exported player | `p14-export.spec.ts` (unzip-serve-boot-tick), `player-backend.spec.ts` (packed `apps/player` over HTTP, both backends) |

### Recovery

| Event | Coverage |
| --- | --- |
| Context loss | Unit only (`create-engine.play.test.ts`, `rgbd-texture-lifetime.test.ts` — `noteRestore`, texture release, material invalidation). **Not covered** in e2e: no spec forces a real `WEBGL_lose_context` on a live session |
| Backend switch | `webgpu-backend.spec.ts` (WebGPU→WebGL2→WebGPU through Project Settings, one Engine, undo/redo and Play after) |
| Backend fallback | `webgl2-fallback.spec.ts` (WebGPU requested while `requestAdapter` returns null, rejects, or `navigator.gpu` is absent → one WebGL2 Engine, presented viewport, explicit reason in Project Settings, Play afterwards, no loading-deadline failures), `player-backend.spec.ts` (packed WebGPU player without an adapter presents WebGL2 with `data-backend-fallback`) |
| Scene reload | `runtime-scene-loading.spec.ts` (repeated transitions + Stop, Play + Preview Build), `runtime-owner-continuity.spec.ts` (`changescene` under held paint, both hosts), `rendering-transitions.spec.ts` (viewport blocking reloads) |
| WebContent termination | Unit only (`session-liveness.test.ts` — liveness record, exit detection, pruning). Capacitor's native handler reloads the WebView; OS delivery on a real device is untested |

## Sustained route

`e2e/play-sustained-route.spec.ts` reuses the performance-room fixture (`e2e/play-performance-fixture.ts`): a deterministic room — floor, three walls, 96 static casters, 16 physics-driven spheres, sun plus six shadow-casting points and two spots — in the minimal test project at the selected quality.

Sequence per run: overlay Play on the editor's shared Engine, 60 s warm-up, then `ceil(minutes / sample)` windows of `BL_PERF_SAMPLE_MS` (default 30 s each, default total 20 min); the same again through a Preview Build (the packed player host on its own Engine). Each window records:

- rAF cadence: fps, interval median/p95/p99, longest, stalls over 33/50/100 ms;
- `longtask` entries (count, total ms);
- canvas CSS/backbuffer dimensions and `devicePixelRatio`;
- `renderDiagnostics()` on the host's test hook: draw calls, `cpuMs`, `gpuMs` (with `gpuAttribution`), the last pressure `FramePressureSample`, `scalingLevel`, scene resource counts (meshes/materials/textures/cachedTextures), accounted `gpuReservations`, shadow passes/bytes, pipeline status and quality limits;
- worker tick rate; `document.visibilityState`.

Artifacts: one JSON attachment per window, a `play-sustained-route` JSON report (env, quality profile, render mode, requested backend, boot timings, per-host engine adapter strings, browser version, headless flag, viewport, page errors) and a `play-sustained-summary` text digest (one line per window). The spec asserts only that the route ran — windows produced samples, the page stayed visible, zero page errors — **it never asserts a frame rate**.

### Running it

```text
BL_PERF_SUSTAINED=1 BL_PERF_QUALITY=low pnpm run test:e2e e2e/play-sustained-route.spec.ts --config playwright.perf.config.ts --project perf-gpu
```

`perf-gpu` is full headless Chromium on the machine's real adapter through ANGLE D3D11; `perf-software` is the ordinary SwiftShader project. Knobs:

| Env | Default | Effect |
| --- | --- | --- |
| `BL_PERF_SUSTAINED` | off | `1` opts in; otherwise the spec skips (CI no-op) |
| `BL_PERF_SUSTAINED_MINUTES` | `20` | Sampled duration **per host** after warm-up |
| `BL_PERF_SUSTAINED_WARMUP_MS` | `60000` | Warm-up per host before sampling |
| `BL_PERF_SAMPLE_MS` | `30000` | Window length |
| `BL_PERF_QUALITY` | `low` | `low`/`medium`/`high`/`ultra` profile written into the project |
| `BL_PERF_RENDER_MODE` | `pbr` | `cel` selects the CEL project |
| `BL_PERF_BACKEND` | project default | `webgl2`/`webgpu` via the project GPU-backend setting |
| `BL_PERF_LABEL` | — | Free-form run label copied into the report |

## Environment and adapter caveats

- **Not device qualification.** `perf-gpu` measures desktop Chromium on ANGLE D3D11; CI and `perf-software` measure SwiftShader (CPU rasterization, GPU-bound). Neither is the A16/WKWebView/iOS-PWA target; iPad WebGPU symptoms could not be reproduced on Chromium/D3D12. The report embeds `engine.getInfo()`/`getGlInfo()` adapter strings, the probe adapter, browser version and headless flag so no run can be mistaken for device evidence.
- **rAF cadence is a presentation proxy.** `pressure.presentationMs` is the interval between the view's own presented frames — only `playMode` handles report it; editor/prefab viewports feed `cpuMs` only. `gpuMs` is attributed to the view only while it is the Engine's sole rendering view (`gpuAttribution` says which); `cpuMs` is `scene.render()` CPU, not total presentation cost.
- **SwiftShader skews the mix.** CPU-rasterized frames hide CPU-side regressions and exaggerate fill cost; the dynamic-resolution valve will step down on long software runs — that is the valve working, and `scalingLevel` in each window records it.
- **Memory admission.** A full session needs sustained memory headroom; that is why runs are pending on this machine rather than failing.
- **No state between hosts.** The Play and Preview Build windows measure the same scene on two different Engines sequentially; they are not concurrent-load data.

## Acceptance thresholds

From [perf-budget.md](perf-budget.md); read each sustained window against them — the route reports, the reader judges.

| Signal | Budget | Where it lands in the report |
| --- | --- | --- |
| Frame pacing | project `playFrameCap` (default 60 → 16.7 ms interval) | `intervals.medianMs`/`p95Ms`/`p99Ms` per window; a real-adapter run should sit near the cap after warm-up |
| Stalls | counted, not budgeted; the #633 recovery reference showed ~0–7 per 30 s at 60 fps | `stallsOver33Ms`/`50`/`100` |
| Long tasks | zero on a healthy run | `longTasks.count`/`totalMs` |
| Tick | < 8 ms combined, ~5 Hz stats cadence | `tickHz` (~60 while uncapped) plus the diagnostics snapshot |
| Draw calls | low hundreds; `DRAW_CALL_WARN_CEILING` 400 | `drawCalls` in `diagnostics` |
| Memory | accounted textures under `TEXTURE_BYTE_CEILING` (2 GB); geometry warn at `GEOMETRY_BYTE_CEILING` (512 MB) | `gpuReservations.reservedBytes`, `resources.cachedTextures` |
| Leak signal | no growth across windows | `resources.*`, `gpuReservations`, `shadowMapBytes` stable window-over-window |
| Resolution | valve may step down under pressure and must not wedge | `scalingLevel`, `width`×`height`, `pressure` per window |

A window that misses the pacing budget is a measurement to explain, not a spec failure — the assertion set stays at "the route ran clean" so the run always produces evidence instead of a red build.

## Engine ownership follow-up baseline

The device waiver below applies only to the engine-ownership follow-up, not to
the separate triangular-shadow qualification recorded at the end of this page.

- Implementation starts at `bf109267b4adf42fe118847f29af1888a8ad1f5e`, after reviewed `ce1162f25cbac930be4789789de6269856e1eb58`. The intervening test-mode and WebGL2-fallback PRs do not change snapshot/physics ownership. Retain the merged #648 vertex-stream patch and existing renderer selection.
- Installed dependencies: Babylon `9.20.0`, Havok `1.3.14`. Packaged and vendored Havok WASM SHA-256: `026917766f534c156286f07975850978dabf17c42e742bbfaaebbcb2215e4e11`. Babylon patch file SHA-256: `2b1f1007a95b4543415a9f67ae023c662b1852b4140a34e710ff68a947bb06f9`; lockfile patch identity: `613782859a2d2336c9cc03314b9e992b211e6607c435e03848d9aa127f314375`.
- Deliveries: A snapshot preparation; B native physics ownership and explicit transforms; C change-driven physics preparation; D installed asset identity, texture leases and stable sprites; E transactional models/text; F particle preparation/playback. Each delivery records targeted evidence separately. No batching, second renderer or general resource framework.
- `snapshot-steady-state.test.ts` measures direct synchronizer preparation for 256 warmed actors with 120 identical, 120 new-frame/unchanged, and 120 moving samples. Native dirty/cleanup calls are counted only inside synchronization; normal render queue resets are excluded. Timing distributions are evidence, not noisy pass/fail thresholds.
- Local browser validation is the requested platform scope; physical A16 verification was explicitly waived. NullEngine evidence does not establish browser output or device performance. Browser/backend results remain unexecuted until recorded for the relevant delivery.

### Delivery A local evidence

Baseline fixture commit `2974e67327a6d486a940f3b40e25d74b75bd2d52`; implementation `ba76a60fa58a1e550ede1f510870a02130b3cd1b`. Windows x64, Node 24.19.0, Babylon NullEngine 9.20.0, texture-free native materials, fixed camera, 256 actors, three warmup renders. Each phase directly applies 120 samples; rendering and fixture mutation are outside the timer.

| Phase | Before median / p95 / p99 (ms) | After median / p95 / p99 (ms) | Global dirty / active cleanup / group cleanup, before → after |
| --- | --- | --- | --- |
| Identical | 0.174 / 0.809 / 1.650 | 0.117 / 0.389 / 0.664 | 120 / 120 / 120 → 0 / 0 / 0 |
| New frame, unchanged values | 0.125 / 0.157 / 0.206 | 0.084 / 0.173 / 0.290 | 120 / 120 / 120 → 0 / 0 / 0 |
| Position and rotation changes | 0.340 / 0.709 / 1.446 | 0.282 / 1.256 / 2.451 | 120 / 120 / 120 → 0 / 0 / 0 |

These single-run timing distributions were collected while other development processes were active. Medians improved but some tails increased; this is not an isolated browser/device speedup claim. The acceptance result is elimination of the named native operations, stable mesh/material identities, and preserved transforms. The existing coordinator already cached strict readiness in the baseline; this change preserves that behavior rather than claiming a readiness redesign.

- Baseline: the new file had five expected failures for dirty/cleanup calls and flag writes; its coordinator readiness case passed. An earlier fixture using the editor checker texture timed out on NullEngine upload readiness and was corrected before the recorded comparison.
- Passed at the implementation commit: `pnpm --silent agent:wait local --script test -- packages/render/src/snapshot-steady-state.test.ts packages/render/src/snapshot-apply.test.ts packages/render/src/create-engine.play.test.ts packages/render/src/bone-attachment.test.ts` — four files, 192 tests. This covers caller deduplication/command invalidation, stale snapshots, SceneLayers, camera possession, bone attachments, structural failure and transform/readiness behavior.
- Render-package `tsc --noEmit` and ESLint for the two changed TypeScript files passed through shared resource admission. Documentation-only evidence updates reuse those unchanged-source results.
- The warmed measurement case was rerun with `--disableConsoleIntercept` to retain successful timing output; six unrelated cases in that measurement-only invocation were filtered out, not counted as new passes.
- Browser: `pnpm --silent agent:wait local --script test:e2e -- e2e/scene-layer-rendering.spec.ts --project=desktop-chrome` passed both Play and exported Preview Build pixel cases at `2c1f29ae28c795acffe40cf4a78dbee94d3f5879`, with one browser worker. The earlier queued attempt was cancelled and is not counted. This fixture uses project-default rendering settings and does not independently qualify WebGPU or capture an adapter identity; dedicated WebGPU and sustained-device performance are not claimed.

## Triangular-shadow investigation — 22 September 2026

**Not ready to merge:** the automatic-bias coverage gap is implemented, but the
first synthetic browser regression still fails. The half-texel depth correction
is a candidate policy, not the smallest visually validated correction. Do not
report the triangular-shadow bug as fixed.

Implementation base: `93638dde6993a8307254d70e96dbad9be42a9432`, Babylon
`9.20.0`. Rendering PR #651 was rechecked at
`6cc7cce3f552d40c15fd807eaadd9cc5b388a587` and its owner was notified of the
controller overlap. Its sampler-budget and binding changes were not copied.

The confirmed code defect is narrower than the reported image: automatic bias
ran only inside the cascade callback. Single-map directional shadows, including
Low and capability fallback, retained authored constants. The implementation now
derives directional depth correction from the current native projection and
admitted dimensions after native per-layer preparation and before caster
uniform binding. It retains authored depth as a floor and authored world-space
normal offset unchanged. Local spot/point adaptation is explicitly unsupported;
their authored offsets remain exact. See [the bias contract](../architecture/render.md).

No original `TestProject222` asset, screenshot-producing build, effective
settings, or physical A16 capture was available. The added box character is a
**synthetic reproduction**, not a replacement for original-asset acceptance.
No controlled experiment has yet established the cause of the original image.
No projection-fitting or geometry/shader change is justified by current evidence.

The synthetic case **does** reproduce sawtooth shadow-map acne. At `d1469bf8`,
turning off shadow contribution while retaining direct light removes the pattern.
Independent depth sweeps reduce it; normal-offset sweeps from zero to 0.01 do
not remove it. Windows Chromium executed actual WebGL2 on ANGLE / Microsoft
Basic Render Driver (D3D11), 384×384 pixels, DPR 1, forward PBR, one 1024²
directional PCF map, distance 80 and a 160-world-unit orthographic span/depth.
This is desktop software-rendering evidence, not A16 evidence.

| Synthetic capture | Native depth bias | False-dark head samples | False-dark torso samples |
| --- | --- | --- | --- |
| Authored manual (same values as the old single-map automatic path) | 0.0001 | 198 / 356 | 41 / 67 |
| Candidate automatic, half-world-texel depth correction | 0.0009765625 | 65 / 356 | 14 / 67 |
| Diagnostic three-quarter-world-texel correction | 0.00146484375 | 23 / 356 | 7 / 67 |

The assertion requires less than 5% false-dark samples in each selected region.
All three captures fail; none is a fixed image. Native PCF Low uses one linear
comparison fetch, not point sampling. Its underlying texel support and surface
depth gradients explain why a constant half-texel correction is insufficient.
Increasing it without preserved contact-edge evidence is not an accepted fix.

The synthetic browser specifications are
`e2e/shadow-self-shadowing.spec.ts` (Low, forced cascade fallback, cascades,
PBR/CEL and explicitly checked WebGL2/WebGPU) and
`e2e/shadow-self-shadowing-hosts.spec.ts` (editor, Play and packed player,
authored-settings round trip and updates). They attach regional visibility
results, direct-light-only reference images, shadowed images and effective-state
captures. The isolated fixture additionally captures independent depth/normal
sweeps, a thin contact, another light angle and cascade camera motion. These
assertions require both lit surfaces and retained occlusion; their presence is
not a passing pixel result.

The first thin-slab capture was invalid: Babylon's deferred mesh-added event had
not registered its shadow participation. The fixture now awaits that event and
checks both casting and receiving. Its second light angle was changed to retain
analytically visible ground contacts. A separate ground-pixel strip near the
thin slab's contact edge supplements the interior mask: the interior mask alone
could tolerate a detached shadow. The edge strip's analytic negative control
rejects a 0.4-world-unit caster lift at both angles. At `e9313484`, the real
WebGL2 sweep retains 25/25 edge pixels at one world texel, but only 19/25 at
1.25 texels and 12/25 at 1.5 and two texels. Visual inspection still finds
low-contrast teeth at one and two texels. The lit-region cutoff is therefore
tightened from 85% to 97% of the direct-light reference; the contact cutoff
remains 85%. This strengthens the oracle instead of accepting a numerically
passing but visibly broken result. A test-only raster-slope probe now isolates
slope correction at fixed authored offsets and records actual caster draws and
state restoration. It does not change production rendering and excludes clamped
cascades, whose fragment-written depth cannot use this raster correction.
Production geometry and projection fitting remain unchanged.

The `90132d14` raster-slope experiment executed real caster draws and restored
the original raster state. It also fails: factor 1 retains 21/25 thin edge
pixels but leaves 52/356 head samples dark; factor 1.25 retains only 12/25 edge
pixels and still leaves 24/356 head samples dark. A test-only receiver-plane
experiment now adjusts comparison depth using each surface's projected
gradient and fractional texel position, retaining native PCF fetches and CSM
depth clamping. Its result is explicitly labeled diagnostic and uses fixed
authored caster offsets; it is not the production automatic policy. A fresh
native Babylon scene compares the same captured projection and light state.
Host assertions now sample exact screenshot pixels without image resampling.

At `4a41ecda`, the receiver-plane experiment removes the visible face bands,
but the WebGL2 PBR head-top check still fails (56/356 samples, 36 unique grazing
top-face pixels). Actual WebGPU executed on SwiftShader and has zero head
failures at this pose; neither result qualifies A16. The matched native
Babylon baseline has exactly matching camera/light matrices and decoded RGBA
identical to the earlier managed authored baseline. This confirms that the
synthetic acne does not require the FrameGraph bridge.

Independent four-texel ray tests identified a test-oracle defect: several arm
and leg samples are valid filtered transitions despite an unoccluded center
ray. All 36 second-angle thin-edge pixels match ideal PCF shading within 0.8
green levels; the old binary darkness gate wrongly rejects 13 valid partial
shadows. Those raw counts above must not be interpreted alone as contact loss.
The revised oracle uses the admitted projection's complete PCF footprint to
separate known lit, strongly occluded and penumbra samples without relaxing
the intensity thresholds. A separate, unqualified per-texel comparison probe
is available to isolate the remaining grazing-face behavior; it preserves
logical filter weights but increases comparison instructions and is not a
production or A16 performance claim.

Baseline instrumentation revision `d1d208eed3d753b2a47931828b183af759850b2b`
retains the original bias policy. Its first selected WebGL2/Low/PBR attempt was
cancelled while awaiting shared resource admission, before any build or browser
execution. It produced no baseline image or test result. A red/green browser
comparison remains required using the same final fixture/oracle on both policies.

At `06de91a184ede3274c64fb4c964dc1323374dd4e`, the first focused unit run
executed seven files: shadow bias, controller, managed FrameGraph shadows,
diagnostics, refresh, player backend and player boot. It reported 74 passed and
5 failed. Failures identified incomplete NullEngine array metadata, a settings
replacement in test setup, Float32 extent precision, and signed-zero JSON
comparison. Affected files were rerun after repair; the first run remains a
failed result rather than being relabeled.

| Check scope | Revision | Result |
| --- | --- | --- |
| `shadow-bias.test.ts`, `shadow-map-refresh.test.ts`, player `player-backend.test.ts` and `boot.test.ts` | `06de91a1` | 43 passed; unaffected results retained |
| `framegraph-managed-shadows.test.ts`, `shadow-diagnostics.test.ts` | `469256c8` | 15 passed; unaffected results retained |
| `shadow-controller.test.ts` | `d1469bf8` | 21 passed |
| ESLint on changed TypeScript files | `469256c8` | Passed with two existing React-hook warnings; subsequent fixture edits require their own scoped check |
| Render, player and editor package typechecks, serialized through shared admission | `d1469bf8` | Passed; subsequent editor fixture edits are not covered by this result |
| Selected `shadow-self-shadowing.spec.ts`, desktop Chrome, `webgl2 low pbr` | `d1469bf8` | Failed the real pixel assertion; images and effective state retained locally |
| Same selected browser case with extended depth/distance diagnostics and registered thin caster | `65faac7d` | Build passed; browser never started before the 900-second admission timeout |
| ESLint on the three updated synthetic fixture/spec files and controller test | `8d69b890` | Never started before the 180-second shared-admission timeout; latest fixture static verification remains pending |
| Selected WebGL2/Low/PBR browser, extended sweeps and registered thin caster | `e9313484` | Build passed; pixel test failed. Contact-edge data rejects the larger constants; no fixed image. |

Focused unit commands used `pnpm --silent agent:wait local --script test --`
with only the named files. Browser commands used
`pnpm --silent agent:wait local --script test:e2e -- e2e/shadow-self-shadowing.spec.ts --project=desktop-chrome --grep 'webgl2 low pbr'`.
All checks kept `BL_TEST_PROFILE=shared`, one worker and the machine-wide
resource policy. No full suite or coverage sweep ran. At the timeout another
workload held the shared browser lease and available memory was below the
browser-plus-headroom requirement. No other workload was stopped or bypassed.

Remaining local work: run the extended sweeps and contact-edge oracle, select
and validate the correction, prove failure with the restored original policy
using the same final fixture, then run the bounded backend/cascade/host matrix.
There is no baseline-fail/fixed-pass evidence pair or passing cross-host result
yet. No PR has been opened because selected verification is not passing.

**BLOCKED qualification:** original-image acceptance and native A16 visual,
motion, thermal, frame-time and repeated-open/play/close resource measurements.
Desktop software pixels and NullEngine contracts cannot satisfy those gates.
No measured speedup, GPU-memory result, or claim of meeting the 5% performance
review threshold is made. The implementation requests no larger maps, additional
cascades, extra scene passes, reduced coverage or production readbacks.
