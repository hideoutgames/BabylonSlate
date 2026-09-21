# Renderer qualification

## Production outline qualification gate

The September 2026 rendering handoff starts from `ce1162f25cbac930be4789789de6269856e1eb58` (reviewed baseline `bc110765198020d6d9a14a0a67ee357a18148080` plus the WebGPU optional vertex-stream fix). Babylon remains pinned to 9.20.0 with the existing repository patch. The production mesh-outline selection implementation remains in place while the native replacement is qualified.

`e2e/native-outline-qualification.spec.ts` runs the stock `FrameGraphSelectionOutlineLayerTask` with disjoint CEL/component instances sharing one source and a third selection consumer. It captures the native output before and after clearing the component consumer, plus the surviving selection-buffer state. The fixture deliberately isolates ownership with depth occlusion disabled; it does **not** qualify global CEL visibility. A passing harness means the evidence was captured and the pinned limitation reproduced, **not** that outlines satisfy release acceptance. Run just this file with the shared browser runner; the JSON attachment lists blockers and actual API, mask type, dimensions and browser. Screenshots come from the actual presented canvas.

Physical iPad A16 testing is **deferred by the user for this delivery (21 September 2026)**. No physical-device baseline, equal-quality before/after timings, sustained thermal behavior or device mask-format qualification has been measured. Desktop WebGL/WebGPU captures are functional evidence only. Do not enable a costly default based on these runs or substitute an alternate outline renderer without the requested product approval.

### Recorded desktop evidence — 21 September 2026

Build `48314f7f090ef8fd404dca5dc62344337c54e77c`, Babylon 9.20.0, Windows 10.0.19045 x64, Intel i5-9400F, Chromium 151.0.7922.34, DPR 1. WebGL2 used ANGLE D3D11 WARP (Microsoft Basic Render Driver); WebGPU used Google SwiftShader. The JSON attachments include the build fingerprint, fixture source hash, requested/effective API, adapter, dimensions and settings. These are software-adapter functional runs, not timing benchmarks.

| Native fixture observation | WebGL2 | WebGPU |
| --- | --- | --- |
| CEL red pixels with editor selection active | 204 | 204 |
| CEL red pixels after adding a disjoint component consumer | 204 | 204 |
| CEL red pixels after clearing only the component consumer | 204 | **0** |
| Shared instance-selection buffer after that clear | **Removed** | **Removed** |

The fixture uses 128×96 pixels, scale 1, a float32 native mask (`mainTextureType = 1`), and three warm-up draws after readiness per membership state. WebGL2 retaining its previous pixels does not establish safe buffer ownership. WebGPU visibly loses the unchanged CEL outline. This is the concrete failure supporting the pending request for a shared bounded-pass extension; it is not approval to implement that extension. Depth occlusion, per-thin-instance ownership, mask-ID precision at scale, deformation and transparency remain unqualified.

The same build passed three standalone settings cases: packed WebGL2, loose WebGPU, and packed requested-WebGPU with an injected adapter failure and effective WebGL2. Each boots authored CEL with five bands, specular off, environment disabled, shadows disabled, FXAA, a 480×270 output, scale 0.8 and cap 30. Presented pixels change under a live PBR request and return exactly when CEL is restored. Scale 0.5 and cap 20 survive a transition whose second-scene geometry is verified; reload restores 0.8/30. The stored manifest retains project defaults. The rejected adapter's diagnostic contains `qualification adapter failure`. This verifies the tested fields, not every rendering setting or every host.

Reproduce only these fixtures with the admitted runner:

```powershell
$env:BL_TEST_PROFILE='shared'
pnpm --silent agent:wait local --script test:e2e -- e2e/native-outline-qualification.spec.ts e2e/render-settings-export.spec.ts --project desktop-chrome
```

The player fixture generates and serves actual packed/loose exports with two primitive scenes from `e2e/preview-scene-fixture.ts`; it does not use editor caches or an editor iframe. Five harness tests passed. Two of those deliberately document the native outline failure. PNG and JSON attachments live in the Playwright result, including authored-CEL/runtime-PBR images and the three native membership states.

Targeted local verification (no full suite or coverage sweep):

| Scope | Recorded result |
| --- | --- |
| `packages/core/src/project.test.ts`, `packages/exporter/src/export-game.test.ts` | 64 passed at `48314f7f`; includes malformed frame caps, minimum dimensions, normalized export/boot defaults and editor-field exclusion |
| Editor `export-game.test.ts`, `export-baked-lighting.test.ts`; player `artifact.test.ts`, `hydrate.test.ts`, `boot.test.ts`, `player-backend.test.ts` | 55 passed at `82e9aff3`; reused for the unchanged option rename and caller contracts; later normalization is covered by the row above and standalone cases |
| `packages/core/src/render-quality.test.ts`, `packages/runtime/src/execute-console.test.ts` | 46 passed at `d0e684a7`; unchanged since, including 80 repeated quality requests producing four renderer updates |
| Typechecks | Core/exporter/editor at `48314f7f`; player at `02e08c9f`; runtime at `335a1d8c`; no workspace-wide typecheck |
| Lint and diff | Changed-file lint plus scoped reruns for repaired files passed; `git diff --check` passed |

Earlier fixture failures (material-name assumptions, reading the cleared canvas, including the live HUD in screenshots, and assuming a console test-hook member) were corrected before the recorded browser pass. They are not evidence of passing player behavior. Required CI has not certified this incomplete handoff.

### Remaining handoff work and release gates

| Priority / work | Status and next requirement |
| --- | --- |
| P0 physical A16 baseline and budgets | **Deferred by user; not a current delivery gate.** No A16 CPU/GPU/p50/p95/p99, input latency, sustained memory or remaining-headroom claims. Agree the representative scene and explicit 60 fps (16.7 ms) or 30 fps (33.3 ms) target, then measure equal content/quality before and after. CPU and GPU headroom must be reported separately. |
| P0 settings contract | Shared authored/export/boot normalization and the cases above are implemented. Complete per-field rendered application, all hosts and backend capability tests remain. See the [application inventory](../architecture/render.md#rendering-handoff-application-contract). |
| P1 editor/component/global CEL outlines | **Native ownership gate failed; alternative approval pending.** Production selection remains the existing mesh-outline implementation. No OutlineComponent/global outline schema or default-on switch is advertised. Lifecycle, strict occlusion, compositing, style grouping, coverage and zero-work-disabled acceptance remain. |
| P1 Class Graph scalability | Repeated existing quality requests now avoid duplicate renderer commands. Typed transactions, renderer acknowledgement/failure results, coalescing, events, full node category and real graph execution tests remain unimplemented. |
| P1 measured headroom | Only command-count behavior is established. GPU/CPU milliseconds, pass savings, memory savings and A16 visual/performance comparisons are **not measured**. |
| P2 rectangular area light | **Not implemented.** Receiver/backend qualification, transform adapter, derived texture pipeline/export, owned resources, debug UI, admission and explicit unshadowed authoring remain after the foundation gates. |
| P0 release | **Not accepted.** The requested production feature set is incomplete. A16 hardware testing is deferred by user; browser acceptance remains required. |

Future A16 qualification should cover empty, representative authored, many objects/instances, many lights, dense overlap, animated characters, and repeated selection/inspector/gizmo interaction runs in editor and standalone player. Existing performance-room tooling below covers only part of that matrix. Direct GPU timer values must be distinguished from estimates; unavailable measurements stay unavailable. Do not derive universal actor/light counts or treat reduced resolution as equal-quality savings.

**Existing sustained route: tooling landed, runs pending.** The route (`e2e/play-sustained-route.spec.ts`, `BL_PERF_SUSTAINED=1`) enumerates on CI and skips without the env flag; no machine with enough free memory has completed a full session yet. Nothing on this page is A16/iOS PWA qualification — desktop Chromium observations only. Budgets live in [perf-budget.md](perf-budget.md); the engine-level design is in [render.md](../architecture/render.md).

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
| `clusteredForward` | `clustered-lights.spec.ts` (native and graph PBR/CEL pixels); `clustered-path-selection.spec.ts` (editor selection, Play, packed player Auto→clustered) |
| `auto` | `clustered-path-selection.spec.ts` (auto resolves `clusteredForward` in editor, Play and packed player; session `renderpath` request is global and non-persistent); `render-path-settings.spec.ts` (project-wide pipeline settings retained through reopen) |

### Style

| Style | Coverage |
| --- | --- |
| PBR | Default everywhere |
| CEL | `cel-render-mode.spec.ts`, `cel-hard-steps.spec.ts` (both backends), `cel-shadow-lifecycle.spec.ts`, `clustered-lights.spec.ts`, `framegraph-forward.spec.ts` (pbr and cel captures), `baked-parity.spec.ts`, `webgpu-backend.spec.ts` (WebGPU CEL proof) |

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
| Scene reload | `runtime-scene-loading.spec.ts` (repeated transitions + Stop, Play + Preview Build), `runtime-owner-continuity.spec.ts` (`changescene` under held paint, both hosts), `rendering-transitions.spec.ts` (viewport blocking reloads) |

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
