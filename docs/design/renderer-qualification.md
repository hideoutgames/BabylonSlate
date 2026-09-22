# Renderer qualification

## Model and generated-text lifetime follow-up

The physical A16 run is waived for this follow-up at the user's request. Acceptance still requires the local native and browser checks below; unexecuted fixtures are not evidence and no device-performance result is claimed.

At `ea3c9667`, the targeted `visual-lifecycle.test.ts` and `text2d-bitmap.test.ts` baseline ran against Babylon 9.20: 5 failed, 6 passed. Two valid same-length GLBs aliased the old vertex value. Model and generated-text material counts each grew from 2 to 202 over 200 cycles. Oversized text was accepted under an injected 64-pixel cap, and 64 small cells produced an unnecessarily tall 256-pixel atlas.

At `e36439b1`, the same two explicit files passed all 18 cases. Added cases cover 200 source-generation replacements with native resource/observer counts, failed preparation/retry, late rejection after newer success, retained text after allocation rejection, and changing canvas measurements. The native patch removes retired AssetContainer scene observers; this head's patch identity is `b3f3611b5c6f5cd75f3e70a5df4809d1378275c980a582d7e7e1951ed9731b10` (before integration of the physics patch). The later shared-texture-animation fixture and rich-text markup extension have not yet run.

`e2e/visual-generations.spec.ts` is a test-build-only WebGL2/WebGPU pixel and lifetime fixture with 100 model and rich-text replacements, MSDF plus bitmap fallback, borrowed material survival and rejected-text preservation. Its browser run, affected-consumer checks and scoped static checks are still pending. Its timing samples include the fixture's preparation and draw work; they are not isolated GPU or A16 measurements.

## Engine follow-up: deferred local verification

The user subsequently requested finishing the source work and opening a PR, retaining the earlier permission to defer unaffordable local checks. The combined source is open as draft [PR #663](https://github.com/hideoutgames/BabylonSlate/pull/663), with source cleanup at `6a3ad892`. Opening the PR does not certify native, browser or scoped static checks. Temporary native-step diagnostics were removed after locating the defect, without removing regression assertions. Required CI and merge gates remain in force; the draft is not ready for merge.

Verification resumed at `c3519d27` on 2026-09-22 with the shared 2 GiB reserve unchanged. Frozen-lockfile installation of the combined patched dependencies succeeded through admission. The isolated `havok-transactions.test.ts -t 'ends retired trigger' --disableConsoleIntercept` probe timed out at 60 seconds on the second physics step, after compound child removal (`agent-wait-jkcekE`). Its owned process tree was terminated and confirmed absent before removing only its stale admission ticket. Native-step boundary diagnostics were added for the next bounded reproduction; this gate remains failed, not deferred or passed.

At `29ec4552`, the same bounded probe confirmed the hang inside `HP_World_Step` (`agent-wait-12vR8x`); its owned descendants and stale ticket were cleared after verification. Adapter correction `82361386` removed native world membership before changing attachments. The probe then completed in 81 ms of test execution but failed its final teleport-trigger exit assertion (`agent-wait-l7MmMc`); it was not a pass. Correction `6158defc` explicitly retires actor overlap generations after membership refresh and successful rollback. Its five-case trigger/teleport/constraint/controller/contact selector waited behind an older workload and timed out before execution (`agent-wait-TjXKWc`). No reservation or recorded descendant from these runs remained after cleanup. The trigger fixture now also exercises failed attachment/teleport rollback while overlapping; this extension and the latest corrections still require the bounded native probe. Other agents' queue entries were left intact.

On 2026-09-22 the user requested skipping checks that cannot fit the machine's available memory and recording them for later. The team's queued particle check was cancelled before execution; no running check or unrelated process was stopped. `BL_TEST_PROFILE=shared` remains required. The shared `local-resources.json` had a 3 GiB reserve at deferral and changed externally to 2 GiB during source integration; this team left it unchanged. Read the current shared configuration when resuming. Do not bypass admission or repeatedly queue these checks while they cannot fit.

Resume through the current runner from `main`'s `42596fb9`: its default low-memory policy admits one root workload and one worker, with no light-job bypass and at least 2 GiB headroom while preserving any higher configured reserve. Inspect the read-only `pnpm test:resources` report before resuming; do not change host configuration to fit a pending check.

Physical A16 verification is waived for this follow-up. Local browser/native verification is deferred where listed below, not counted as passed. No desktop or software-WebGPU result establishes device performance. Required CI and merge gates remain unchanged.

| Delivery | Historical source/evidence | Pickup |
| --- | --- | --- |
| A: snapshot synchronization | `3d0031bd`, `t3code/engine-ownership-performance`. Four explicit unit files passed 192 cases at `ba76a60f`; scoped render typecheck/lint passed. Two desktop Play/Preview pixel cases passed at `2c1f29ae`. Snapshot-attributable global dirty/cleanup counts fell from 120 per 120 samples to zero. | [PR #657](https://github.com/hideoutgames/BabylonSlate/pull/657) merged as `556c4e349d6c32d37bb70fcfbef7fa27954a0fa0` on 2026-09-22. Verify run `35716813370` passed all nine jobs at `ccd0a446`, with public-hygiene passing. This certifies A's delivered scope, not the later B–F integration. |
| B: native physics lifecycle | Latest B checkpoint `94314580`, `agent/engine-physics-lifecycle-b`. Earlier real-Havok removal/resource cases passed, but the immediate teleport ray failed and a compound trigger case hung before the latest corrections. Those corrections are unverified. | Resume the isolated native trigger and teleport/constraint/controller cases first, then the explicit lifecycle/transaction files, affected Rapier/runtime callers and scoped static checks on the combined source. Native detachment, compound lifetime, local pose and immediate teleport/query release gates remain open. |
| C: dirty physics preparation | Frozen baseline fixture `de96b6d3`, `agent/engine-physics-dirty-c`; latest implementation `cf81fff2` is integrated into the combined branch. Neither the five-case baseline nor the implementation preparation/invalidation fixtures have run. | Run `packages/runtime/src/physics-sync-preparation.test.ts` at the frozen baseline, then compare the combined implementation. Validate native B before treating C as deliverable. |
| D: texture leases and stable sprites | Historical D branch `67538a89` follows source `b8a11880` and notes `5fe391b3`. Earlier batch: 68 passed, 7 failed. Fixture repairs, native cube/environment changes and later admission/cancellation fixes are unverified; the earlier typecheck at `0e675860` does not certify them. | [Current unit, editor, static and browser commands](../architecture/render.md#texture-ownership-verification-pickup), plus the recent correction selectors below. Includes the unrun 10,000-selection WebGL2/WebGPU fixture. |
| E: model/text visual lifetimes | Historical source `64599304`, notes `233b75ba`, browser correction `b32b9a8f`. Baseline: 5 failures/6 passes; implementation at `e36439b1`: 18/18 in the same two files. Later editor staging, multipart budgets and additional ownership changes are unverified. | [Current segmented native/consumer/browser commands](../architecture/render.md#visual-ownership-verification-pickup), plus scoped static checks and the staged material gate below. The combined patch now contains both AssetContainer and physics changes; its installation and verification remain pending. |
| F: particles | `79a00663`, `agent/engine-particles-f`. 49 cases passed across earlier checkpoints. Two follow-up cases at `150ee60a` were cancelled while queued, with no execution. Later clock-ordering, D integration and browser changes are unverified. | [Particle pickup commands and evidence](https://github.com/hideoutgames/BabylonSlate/blob/79a006630853b990d971a5e805ac70e1382771ed/docs/architecture/particles.md). Resume the two selected lifecycle cases, scoped render/editor checks and four CPU/GPU × WebGL2/WebGPU browser cases. Particle-specific exported-player lifecycle verification remains open. |

The first native-physics probes, from the current combined worktree after its admitted frozen-lockfile installation, are deliberately bounded and sequential:

```powershell
$env:BL_TEST_PROFILE = 'shared'
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'ends retired trigger' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'teleports falling|keeps constraints|retains controller|defers contact' --disableConsoleIntercept
```

Before resuming, compare the working head with the recorded checkpoint and select checks affected by intervening source, dependency or configuration changes. Keep failed, cancelled and unexecuted results separate from passes. Record exact source, command, backend and resource/operation counts for each resumed batch. B–F share draft PR #663; the work remains unmerged and is not verified complete.

### Combined source checkpoint

At `4fbb2e8a`, `agent/engine-followup-integration` combined rendering ownership with native lifecycle B `94314580`, physics preparation C `cf81fff2`, material admission `bef1b987`, bounded texture preparation `ae6b86ee`, texture hierarchy staging `f5aa8549`, model material preparation `e07e7e9d`, exact private material release `96018dba` and multipart publication `885e53b8`. At that checkpoint no installation, typecheck, build or test had run; subsequent installation, native probes and corrections are recorded above. Source integration does not close any deferred gate.

Merge `01d342ac` includes `main` through `556c4e34`: A's confirmed merge, the shared execution policy from `42596fb9`, and `f48a4adc`'s loading-stall diagnostics, WebGPU/clustered-material fixes and graph conversion behavior. Source review is not execution evidence. Include `snapshot-steady-state.test.ts`, the loading/dedup cases in `create-engine.play.test.ts`, and `scene-perf.test.ts` when resuming the combined snapshot/readiness segment. The already listed material-library and particle ownership cases cover the directly affected publication consumers; these checks remain unrun on the combined head.

The combined Babylon patch retains the merged WebGPU fixes, E's AssetContainer observer retirement and B's Havok null-handle/native-result fixes. Its LF-normalized SHA-256 and all lockfile patch references are `78c5e57ba857e093f52f241f213c75b265124a78d44a7190f7250cd202f209e1`. Dependency versions were unchanged during conflict resolution; validate the combined patch through the normal admitted frozen-lockfile installation before native/browser checks. Do not reuse either track's installed Babylon package as proof of the combined dependency.

Resume [physics preparation and native lifecycle checks](../architecture/physics.md#change-driven-preparation-and-verification-pickup), [texture ownership checks](../architecture/render.md#texture-ownership-verification-pickup), [visual ownership checks](../architecture/render.md#visual-ownership-verification-pickup), and [particle checks](../architecture/particles.md) in their recorded segments. Run production checks on the current combined branch, including later integration repairs, rather than treating an earlier delivery branch as current evidence. The frozen C baseline remains separate at `de96b6d3`; compare it before measuring the implementation. Render integration also adds unrun authored-sprite material restoration/upload-race cases in `mesh-assets.test.ts` and the directly affected `scene-lighting.test.ts` consumer.

Source integration found that native texture readiness can precede completion of the lease's allocation checks. Environment replacement now retains the prior view until the full successor lease preparation succeeds. `environment-lighting.test.ts` adds an unexecuted native-ready/deferred-admission rejection-and-success regression, including no automatic retry churn after rejection. Include it in the recorded environment batch; no runtime or compilation result is claimed for this correction.

Recent correction checks are all **deferred**. Run these explicit groups sequentially on the final combined source, using the current shared resource configuration:

```powershell
$env:BL_TEST_PROFILE = 'shared'
pnpm --silent agent:wait local --script test '--' packages/render/src/material-library.test.ts -t 'native-ready|resetting its default|cancelled material preparation'
pnpm --silent agent:wait local --script test '--' packages/render/src/resource-cache-texture.test.ts -t 'bounded texture preparation ownership'
pnpm --silent agent:wait local --script test '--' packages/render/src/environment-lighting.test.ts -t 'waits for successor admission'
pnpm --silent agent:wait local --script test '--' packages/render/src/visual-texture-replacement.test.ts packages/render/src/skybox.test.ts
pnpm --silent agent:wait local --script test '--' packages/render/src/model-material-preparation.test.ts
pnpm --silent agent:wait local --script test '--' packages/render/src/visual-model-parts.test.ts
```

The first three selectors cover `bef1b987`'s five material-admission cases, `ae6b86ee`'s four preparation-lifetime cases and `07ecf628`'s environment admission case. At `f5aa8549`, eleven hierarchy cases use real Babylon meshes/materials/cache leases with controlled preparation outcomes; cube IO is mocked. They cover Play/editor rejection, stale completion, owner disposal and first-skybox cleanup, not browser decode or pixels. `e07e7e9d` adds seven valid-GLB model material admission, shader preparation and cancellation cases. `96018dba` adds exact asset-filtered private material release; include `material-library.test.ts` in full in the selected material batch to cover it. None of these authored cases supplies a passing native resource count yet.

`885e53b8` adds eight unexecuted valid animated-GLB multipart cases: initial/replacement publication, failure/retry with retained ownership, supersession/removal and material commands during preparation, including A-to-B, A-to-B-to-C and A-to-B-to-A private-owner transitions. The combined source retains the old hierarchy until every prepared part can publish its visual and animation ownership together. This pending-visual correction does not implement a separate transaction for standalone material-GUID assignment; that pre-existing mutation path remains a separate source follow-up, not a tested ownership guarantee.

After those corrections pass, resume only their affected consumers from the architecture notes, including `material-parameters.test.ts`, `resource-cache-upload.test.ts`, `snapshot-apply.test.ts`, `editor-scene-sync.chunks.test.ts` and `scene-loader.test.ts`, then scoped static and browser segments. Browser runs must report requested/effective backend and driver. Software WebGPU is a local correctness result; fallback does not pass a WebGPU gate. Real packaged Havok is required for collider/teleport acceptance, and browser emission/readback remains required for GPU particle behavior.

Sustained-route status: **tooling landed, runs pending.** The sustained route (`e2e/play-sustained-route.spec.ts`, `BL_PERF_SUSTAINED=1`) enumerates on CI and skips without the env flag; no machine with enough free memory has completed a full session yet. Its browser observations are desktop Chromium only; nothing on this page establishes A16/iOS PWA qualification. Budgets live in [perf-budget.md](perf-budget.md); the engine-level design is in [render.md](../architecture/render.md).

### Historical rendering integration checkpoint

The earlier `agent/engine-render-ownership-integration` checkpoint combined A `129f1f4b`, D `5fe391b3`, E `233b75ba` and F `79a00663`, plus browser backend-reporting corrections D `67538a89` and E `b32b9a8f`. At that historical checkpoint B/C and the physics native patch were separate; they are included in the current combined source above. The textual conflict on this page retained both the model/text evidence and the deferred-check index.

Manual integration review retained the separate snapshot membership/pose passes, snapshot identity and seen-slot guards, transactional model/text publication, exact texture leases, particle generation cancellation, and all three test-mode browser hooks. Particle systems now retire before the material library during handle disposal, so native users release their per-emitter materials first. The merged Babylon patch and lockfile match E's observer-ownership patch and retain the existing vertex-stream fix.

No tests, static checks, build, dependency installation or browser runs were performed for this integration checkpoint. Earlier delivery results apply only to their recorded sources. Resume the scoped pickup commands above and in the linked architecture notes after dependencies are installed with the final combined patch. This integration branch has no PR and remains unmerged.

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
| Baked lighting | `baked-parity.spec.ts` (synthetic-atlas PBR/CEL parity), `baked-player.spec.ts` (Preview Build), `baked-runtime.spec.ts`; authoring side `scene-bake.spec.ts`, `scene-bake-job.spec.ts`, `bake-provider.spec.ts`, `bake-uv.spec.ts` — the quality-tier bake variants are local-only (`BL_BAKE_QUALITY_E2E=1`) |
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
