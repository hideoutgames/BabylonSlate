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
| Snapshot publish | Measured, outside the tick budget | Stats `publishMs`: per-tick SceneLayer overlay layout and removal pass plus one world composition and buffer write per `advance()` burst. Shown beside script/physics; not in `isTickOverBudget` |
| Draw calls | Low hundreds | Prefer instancing; surface in stats HUD |
| Editor edit (React commits) | Measured, no budget | `e2e/editor-edit-profile.spec.ts` with a `VITE_REACT_PROFILING=true` build reports commits and Profiler durations per region for Scene Details, Class graph, Content Browser search and Tilemap paint edits. See [editor-edit profiling harness](../architecture/testing.md#editor-edit-profiling-harness) |

## Memory

| Resource | Budget | Notes |
| --- | --- | --- |
| Editor + project open | Engine Settings texture budget (default **2 GB**, on) | LRU trims **unreferenced** entries toward 80% of the budget. 512 MB is an iPad suggestion, not the runtime default. WKWebView kills the tab rather than swapping |
| Overlay Play / player PCM | Engine Settings audio budget (default **256 MiB**, on) | Unpinned decoded clips LRU-evict; AudioV2 buffers dispose on evict. 64 MB is an iPad suggestion. Audio Preview is not this cache |
| Max concurrent voices | Engine Settings (default **32**, 8–128) | Oldest voice stops when over cap |
| Geometry | **512 MB** warn (`GEOMETRY_BYTE_CEILING`) | Accounted Scene GLB verts/indices. HUD Geo High. Not LRU, not Settings. 256 MB iPad suggestion in docs |
| Texture accounting | Self-computed bytes | No `performance.memory` on Safari |

Bytes per texel (unit-tested): RGBA8 = 4, ASTC 4×4 = 1, plus ~⅓ for mipmaps.

## Runtime physics and water composition

Per fixed tick, inside the ~3 ms physics share of the combined game-tick budget. Main and SceneLayer overlay physics follow the same rules ([physics](../architecture/physics.md#per-tick-transform-work)):

- One pre-step world-pose composition of physics participants and their ancestors; it is the tick's cycle/shear validation boundary. No other per-tick physics or water pass composes the whole world, except the water and readback fallbacks below (snapshot publishing composes once per published frame; see the worker rule below).
- Body membership scans each eligible actor's components once; only statics with a dynamic or kinematic ancestor scan again to decide hosting. Unchanged collider, rigid-body, mesh-source and static-pose descriptors are compared in scratch and copied only on change.
- Water: no transform work without an enabled water surface (a Landscape alone costs nothing). Otherwise only water, removal-volume, Landscape and buoyant actors plus their ancestors. Any duplicate actor guid in the world, or a parent cycle on a selected chain, falls back to composing the whole world. Each script `sampleWater` call evaluates separately: only water surfaces (or the selected water actor's) and cutters plus their ancestors, never buoyant actors, and without replacing the step's evaluation.
- Readback: no composition when no body is parented; otherwise only the parented bodies' ancestor chains. A tick whose Movement transition events ran scripts recomposes the whole world, as before. Static bodies are not read back at all.
- Static teleports: none while a static pose and its ancestors are unchanged; one per tick while they move ([static bodies](../architecture/physics.md#static-bodies-follow-their-actor)). Collidable statics under a dynamic or kinematic body ride on its compound with no teleports, and a moving host does not rebuild that compound; a child moving relative to its host rebuilds it on each tick it moves ([hosted shapes](../architecture/physics.md#collidable-static-children-of-simulated-bodies)).
- The composition reductions leave simulation results unchanged: per-tick world snapshots are identical for acyclic hierarchies. (Static bodies following their actor is a deliberate behavior change, deterministic within a build.)

Deterministic counts, not timings, guard these rules: `physics-tick-composition.test.ts` keeps transform reads of 2,048 unrelated actors at zero, beside `physics-sync-preparation.test.ts` and `ragdoll-sync-performance.test.ts`; `physics-static-follow.test.ts` counts zero teleports per tick in a steady Havok static scene and exactly one per tick for a static trigger carried by a moving parent; `physics-hosted-shapes.test.ts` counts one compound build for a falling, then resting host with a hosted Mesh child. The pre-step pass still scales with participants, which include every 3D MeshComponent actor. Call-time paths compose only the actors they touch ([physics](../architecture/physics.md#call-time-pose-writes-and-queries)): `teleportActor` composes nothing for an actor that cannot own a body and otherwise only its ancestor chain; collider-class `applyComponent`, Mesh/Ragdoll refreshes and `moveCharacter` compose their actor's chain; constraint edits still scan the world for joints but compose only joint endpoints. The same test file counts zero unrelated transform reads for script pose writes, water queries and Project Cursor To Scene beside 512 render meshes. Movement motors reuse the step's pre-step composition until a transition event script writes a pose; later motors in that step then compose only their own chains. Project Cursor To Scene has Line Trace's freshness instead of a whole pre-step pass per call, so same-tick spawns, removals and moved static descendants reach its ray at the next step.

## Render rules (agents)

- `adaptToDeviceRatio: false`; resolution via `setHardwareScalingLevel`. The dynamic valve reads a per-view `FramePressureSample` — presented-frame interval (null on skipped/hidden/loading frames, never zero), `scene.render()` CPU, and engine GPU time only when the view is the sole rendering view — and scales down on the 15-sample median of the worst signal, up only on proven presentation + CPU/GPU headroom. Only `playMode` handles (Play overlay, Preview Build, standalone player) report presentation/GPU signals: their frame pacing is meaningful. Free-running editor/prefab viewports feed `scene.render()` CPU only — their presented-frame interval measures host event-loop contention, not frame cost — and the valve falls back to the cost-only headroom rule for them.
- MSAA off on iPad baseline.
- `skipPointerMovePicking: true` on all scenes (touch has no hover).
- Medium requests four 2048 directional cascades and 1024 local maps, with Auto capacity of two local shadow lights. Effective admission can reduce these requests to fit attachment, face/pass, sampler and shared-Engine budgets; see [rendering profiles](../architecture/render.md). Authored post-process stacks default to empty. Engine Settings `postProcessingEnabled` defaults **on** and can skip attaching those stacks in the editor / Play preview without changing the scene or exported games.
- Water tiers are authored targets, not measurements ([water tier table](../architecture/render.md)). Medium is the A16 baseline: Medium shading, 0.75× mesh density, 512 contact cells, a half-resolution refraction copy, sky-only reflections and no FFT. Low drops the scene copy and halves mesh density for budget Android phones; Screen Space reflections and FFT detail start at High. Profile Medium water on the A16 iPad and record the result here before changing these tiers. Water quality changes are settings-time only: the per-Scene accessor is cached and readiness is invalidated once per change, never per frame.
  - Medium's refraction is mostly a frame cost, not a fragment cost. With no effect chain (the default project), each frame with copy-sampling water in view:
    - draws the whole view into an own full-resolution colour + depth pair (RGBA8 + `DEPTH32_FLOAT`, 8 B/px; 12 B/px on WebGPU);
    - stores that depth so the copy can read it, and reads it again in the half-resolution copy pass (2×2 taps per copy texel);
    - ends with a full-screen `Water output` blit to the backbuffer.
  - Both targets stay allocated while the view plans the copy, even when that water is off screen: about 31 MB for the own pair plus 7.7 MB for the copy per view at the iPad's 2360×1640 ([budget](../architecture/render.md#forward-framegraph-task-order)). An effect chain shares its scene targets and needs no own pair or blit.
  - Scenes without enabled copy-sampling water plan, allocate and run nothing for refraction; scenes without visible water run no planar pass and no FFT simulation.
- Water fragment shading per Water Shading Detail, counted from the generated shader with Crest Foam, Surface Foam and Subsurface on (and Sparkles for Stylized) (design estimates, not measurements; per fragment, custom water code only). Transcendentals are `sin`, `cos`, `exp`, `pow` and `log` per scalar component (Realistic's per-channel `exp` counts 3); roots are `sqrt`, `length` and `normalize` calls; `log2` / `exp2` are listed where used:

  | Tier | Realistic transcendentals / roots / value noises / cell evaluations | Stylized transcendentals / roots / value noises / cell evaluations | PBR light loop (Realistic) |
  | --- | --- | --- | --- |
  | Low | 26 / 19 / 3 / 0 | 18 / 11 / 3 / 0 | none (unlit) |
  | Medium | 48 / 24 / 9 / 1 web (+ 1 glitter cell) | 32 / 13 / 7 / 1 | scene light slots |
  | High | 63 + `log2`, `exp2` / 24 / 10 / 3 webs (+ 2 glitter cells) | 38 / 13 / 8 / 1 | scene light slots |
  | Ultra | as High (plus derivative-based glitter widening) | 38 / 13 / 8 / 1 | scene light slots |
  | Before tiers (older count: call sites, roots included) | 126 / – / 12 / 2 | 68 / – / 8 / 1 | at least four slots |

  - A value noise is four hashes (about 50 ALU); a Stylized cell evaluation four jittered cell distances (about 120 ALU); a Realistic bubble web (`swWeb`) nine jittered points of a 3 × 3 neighbourhood compared by squared distance, two roots (about 200 ALU); a glitter cell one two-component hash and a lit core (about 25 ALU). Low evaluates only the medium, large and (Realistic) foam-clump noises: its blobs, streaks, breaking zones and Realistic foam lace (two triangle-wave folds and their derivatives, about 15 ALU, no fetch or transcendental) derive from them. Stylized bends its large noise's domain by the medium noise on every tier (about 6 ALU), so colour drifts never show the noise's cell grid. Stylized Low (the Sea of Thieves-like redesign) is colour, depth and view shift, two-band swell lighting, a painted sky gradient, a sun streak, crest caps and the shore band from those two noises plus one crest-aligned noise (cap break-up and Low's foam lobes) and cusped parabolic close-up ripples (a `fract`, about 6 ALU): no cell pattern, no sparkles, no crest glow and no added transcendental. Medium adds the crest glow (about 35 ALU), one capillary ripple (three transcendentals), one cell evaluation for the foam blobs, one wind-streak noise for the patches, a second wash band, contact ripple foam and sparkles (three hashes); High and Ultra add a second capillary ripple (three transcendentals) and one bubble noise on foam edges. No Stylized tier adds a sampler or a texture fetch beyond the shared terrain and contact fields (and the copy and reflection features, below). Transcendentals run at about quarter rate on Mali and Adreno, so Low's realistic shading is roughly a quarter of the old cost before counting the removed light loop (about 60–90 ALU per light slot plus shadow taps). Open water fetches two textures (terrain and contact fields); the four shoreline taps run only over known terrain with waves. Ultra deliberately costs about the same as High per pixel: its budget goes to render-target features (refraction, reflections, FFT).
  - Realistic look pass (counts above include it): Low adds only ALU and no fetch or sampler: the wave-phase swash (which drops the old wash band's sine) and depth-limited surf, the wet band (one `fwidth`), the cap skirt, the downstream-stretched contact collar (`length` and `normalize` of the current), the far sun-lobe compression and the analytic sky (`normalize` of the reflected ray, two `length`s for its azimuth and `sqrt` of the slope variance, only without an environment or skybox; its powers are multiplications) cost about 80 ALU and four roots, and Low still uses one scalar transmittance, so its transcendental count is unchanged. Uniform-only sun terms (the horizontal sun direction, the low-sun horizon warmth, the share of sunlight entering the water, the light through crests per channel and the glitter's sun visibility) are computed on the CPU (`slateWaterSunShape`, `slateWaterThrough`, `slateWaterSky.w`), not per fragment. Medium adds per-channel transmittance (one vec3 exponential, 3 scalar operations, in place of one scalar one; with the old wash band's sine gone Medium rises by one transcendental), the bubble web (its one web evaluation, at twice the large scale), one glitter cell for the near sun-path sparkles and Subsurface's view-to-sun term. High and Ultra add the finest capillary octave (3 transcendentals, faded within a few metres), the churned and small-bubble webs (three web evaluations in all; the foam grain noise is gone: one value noise fewer), two glitter cells with a `log2` and an `exp2` for the far sun-path sparkles (about 60 ALU) and, only over the contact field's bounds, the wake: two explicit-level taps of the contact field already bound (no new sampler) behind a branch, so open water skips them. The CPU binds five more vec4s per draw (`slateWaterSky`, `slateWaterHorizon`, `slateWaterAbsorb`, `slateWaterSunShape`, `slateWaterThrough`) from per-frame scene data written in place: no allocation and no per-frame material dirtying.
  - Zero-valued Sparkles, Crest Foam, Surface Foam or Subsurface compile out on every tier, and uniform-only terms (chop and capillary constants, slope sums, ripple phase, per-asset factors) are computed once per bind on the CPU, allocation-free.
  - Profile Medium water on the A16 iPad and Low on a budget Android phone with the Play performance route before quoting frame-time savings.
- Refraction and object reflections per water fragment (design estimates, counted from the generated shader; each compiles only where it runs, see [Water](../architecture/render.md#water)):

  | Tier | Refraction | Object reflections | Extra samplers (Realistic total) |
  | --- | --- | --- | --- |
  | Low | none (no scene copy is planned) | none (sky) | 0 (4) |
  | Medium | 3 copy fetches (2 nearest-depth loads, 1 filtered colour), about 40 ALU, plus the per-frame own pair, copy pass and output blit above | none (sky) | 1 (5) |
  | High | as Medium, from a 0.75-resolution copy | up to 16 march steps (one nearest-texel load each, plus one probe load at a step that passes the far side of a face) + 4 bisection loads + 1 hit texel load, and on a hit at a silhouette of the downsampled copy 4 depth loads + 1 texel load (about 22–27 fetches and 330 ALU when a ray marches the full length; misses stop at the screen edge) | 1 (5; 6 with the FFT detail band) |
  | Ultra | as Medium, from a full-resolution copy | the dominant flat body: 1 planar fetch and a mat4 transform of the reflected ray's point one eye distance out (about 25 ALU); other bodies: up to 24 march steps + 4 bisection steps (no silhouette loads at full resolution) | 2 (6; 7 with the FFT detail band) |

  - The depth pre-pass variant returns before this code (`DEPTHPREPASS`), so it is paid once per pixel. The pre-pass draws under its own render pass id ([transparent depth pre-pass](../architecture/render.md#forward-framegraph-task-order)), so frozen Play materials keep that variant too, and unfrozen ones prepare no effect per frame. Lookups and uniform writes on the CPU run per draw only for variants that compile the features: two map reads, two vec4 writes and, with a planar reflection, one mat4 write; no allocation and no per-frame material dirtying.
  - The copy pass, the opaque/transparent split and the planar mirror pass are costed in [Water scene copy](../architecture/render.md#forward-framegraph-task-order) and the planar owner notes; they run only while copy-sampling or mirrored water is visible.
  - Profile High's march on a desktop GPU and Medium's refraction on the A16 iPad with the Play performance route before quoting frame-time costs.
- FFT ocean detail per water vertex and fragment (design estimates, counted from the generated shader; `SLATE_WATER_FFT` compiles it only where device-effective FFT Ocean Detail runs and Detail Waves is above 0, see [Water](../architecture/render.md#water)):

  | Tier | Fragment | Vertex (GPU waves) | Extra samplers (Realistic total) | Simulation (when the water clock moves) |
  | --- | --- | --- | --- | --- |
  | Low, Medium | none | none | 0 (4 / 5) | none |
  | High (128², 2 cascades) | up to 4 filtered array fetches (2 per cascade still resolved) and about 85 ALU (combined Jacobian, its floor and J⁻ᵀ) | none on Global Water and large volumes (`SLATE_WATER_FFT_VERTEX` 0: their grids cannot resolve the first cascade); on small dense volumes, 6 shear MADs per swell component, about 60 ALU and up to 4 fetches | 1 (6), shared with the vertex stage | 18 passes, 3 MiB |
  | Ultra (256², 3 cascades) | up to 6 fetches and about 105 ALU | 2 fetches (the first cascade) on Global Water's dense core, none on coarser cells, and about 75 ALU plus the shear (compiled only into surfaces whose grid resolves the first cascade) | 1 (7) | 22 passes, 18 MiB |

  - Taps follow the footprint: each cascade fades by its shortest wavelength against the pixel footprint (fragment) or the mesh spacing and view footprint (vertex) and then skips its fetches, so distant water pays for the first cascade or none. Ultra's three cascades split High's band more finely rather than extending it, so its first cascade stays resolved about 2.4× farther than High's; its extra fragment taps buy detail at mid distance and its vertex taps buy geometry on dense meshes. The depth pre-pass runs the vertex part only.
  - Until the band is ready, and while it is refused (ledger or the three-simulation cap), every cascade is faded: both stages pay only the fade arithmetic and take no fetch.
  - CPU per draw of a sampling variant: one band lookup, about 20 float operations and 4 vec4 writes (`slateWaterFft`, `slateWaterFftCascade0-2`); no allocation, no per-frame dirtying. The define never follows readiness, so a band becoming ready never recompiles water. The simulation's own CPU and GPU budget (spectrum steps of about 1 ms, passes and memory per tier) is in the FFT notes of [Water](../architecture/render.md#water).
  - Scenes without visible water whose shader samples the band run no simulation and no passes.
- Built-in water displaces a static rest grid in its vertex shader (`SLATE_WATER_GPU_WAVES`): frames upload no water positions, normals or per-vertex wave data. Only a rebuilt grid or a rotated or scaled volume rewrites its static attributes; a translated volume uploads nothing, and a Global Water recentre (a moving or orbiting camera crossing a cell) uploads only its position stream into the same buffer, with no per-vertex rest data or allocation. The terrain field's per-frame change check compares numbers over a per-scene landscape list, without scanning the scene or building strings. Custom Material water keeps CPU-displaced vertices. A surface that no pass drew last frame and no camera frustum contains skips its CPU vertex work and its terrain and contact refreshes. Water never casts shadows, so visible water no longer forces local shadow maps to re-render each frame. Mesh Density scales cells per side, so vertex-shader work scales with its square (Global Water capped at 192 cells per side). These are design estimates; measure with the Play performance route before quoting savings.
- Pause render loop, game worker, and encode queue on `visibilitychange` / app background.
- Visible editor viewports always render at `viewportFrameCap` (default 30); freeze when hidden (zero-size or fully off-screen), obstructed, or a modal is open. IntersectionObserver plus an on-screen rect fallback; continuous-render leases stay refcounted.
- Idle-unmount inactive chrome-tab workspaces after 2 minutes (`p18-inactive-documents`); cap 3 warm non-CB DockViews. **Open Scene tabs always stay mounted** and count toward that cap. P4 freeze is not a substitute for unmount. Remount restores layout / camera / graph viewport.
- Content Browser **grid** is window-virtualised (`p18-content-browser-virtualize`); TreeView already is. Revoke off-screen thumbnail blob URLs.
- Add Node catalog **body** is window-virtualised (`p18-add-node-virtualize`); category sidebar stays unwindowed. Distinct from canvas `p18-graph-virtualize`.
- Output Log and Compiler Results window-virtualise to viewport plus overscan (`p20-log-virtualize`; `WindowedList` / TreeView arithmetic). Ring buffer cap 500 stays. SearchDialog (AssetPicker / ClassPicker) uses the same helper. Place Actors catalogs stay unwindowed. Global Search **result** body is not virtualised.
- One `Engine` per **open project** (hidden constructor canvas). Scene viewport, Play overlay, Material Preview, **and Prefab Preview** are `sharedEngine` clients (`p18-shared-prefab-engine`). Close project disposes Engine + ResourceCache.
- Play/Preview renders at project `playFrameCap` (default 60), not the editor viewport cap.
- Construct asset image textures only through `ResourceCache` (stable blob URL + canonical sampling flags). Renderer-owned dynamic targets (`RenderTargetTexture` and `RawTexture` data/fallback textures) are exempt and account their bytes through `beginManagedRenderAllocation`. **One cache per Engine lifetime** (`p20-shared-resource-cache`): Play / Prefab / Material reuse the viewport cache even when `sharedEngine` is set. Each `createEngine` handle holds leases on its textures (`bindResourceCacheToHandle`); LRU eviction of **unreferenced** entries (not leased by any handle) trims toward 80% of the Engine Settings ceiling (default 2 GB). `getTexture` accounts sniffed KTX2/PNG sizes.
- Editor static `freezeWorldMatrix()` / `material.freeze()` / unique-id maps / scene-load `forceCompilationAsync` are **Done** (`p20-editor-scene-freeze`). Editor scenes no longer freeze the active-mesh queue; the FrameGraph collects its own objects. Visible editor stays at `viewportFrameCap` — do not dirty-skip an on-screen scene. Remount dialog: Collecting Assets → Loading Models → Warming Shaders.
- Play prepare caches compiled scripts by graph content hash and loads Audio `source` chunks on first `playSound` (`p20-play-compile-audio`, **Done**). Overlay Play and `apps/player` share the lazy audio path.
- Global Search rebuilds when the dialog is initiated (`p20-search-on-demand`, **Done**), not on project open. Async/chunked; include open-document JSON. No on-disk search cache.
- No per-actor per-frame allocation in snapshot apply (reuse scratch math objects). `SnapshotInterpolator.push` copies into two owned `Float32Array`s (ping-pong); do not `slice()` a new buffer per snapshot. Each sampled snapshot identity (`frameId`, α, layout generation) applies once per frame even though registered-view admission and the render loop both sample; audio pose/listener sync rides the same apply so capped draws still sync once.
- Play overlay / packaged-player HUD must not `setState` (or rewrite chrome DOM) at 60 Hz. Worker `stats` is ~5 Hz; rAF FPS sampling is 1 Hz. Tick stamp and worker timings also live on the snapshot header.

## Runtime tick rules (agents)

The worker counterpart to the snapshot-apply rule: no whole-world work or per-actor allocation per tick unless its output needs it.

- Compose every actor's world pose once per published frame, through the driver's `WorldTransformComposer`: each guid keeps its pose object and sheared-matrix buffer across publishes and is rewritten in place, so a steady world allocates nothing per actor; guids a publish no longer composes are released. Results equal a fresh `composeActorWorldTransforms` bit for bit, and the snapshot write reuses one `ActorSlot` scratch. `advance()` defers the composition and buffer write of its catch-up ticks to one write when the burst ends; each tick still lays out SceneLayer overlays (the next tick's focus navigation and scripts read the arranged poses) and runs its removal pass (stream retirement, `despawn`, slot release). A bare `tick()` and explicit publishes (scene, layer and stream readiness, SceneLayer scrolling) write immediately.
- Other per-tick passes compose only the actors they read: the crowd composes NavAgent actors and their ancestors, ragdolls their owners (`firstSpawnedWorldTransforms(actors, selected)` / `composeActorWorldTransforms`, which return fresh poses). The published frame composes through `World.findActor` instead of building a guid index. Roots copy their pose, and children of uniformly scaled parents (or unrotated children) keep the per-axis composition; only rotated children of nonuniform or mirrored parents multiply and decompose 3×4 matrices through module scratch buffers, and only sheared actors retain an exact matrix for their descendants.
- Build the frame's first-spawned guid index (`navFrameActors`) only when behaviour trees or a navmesh can read it, with a plain loop.
- Reuse scratch `Set`s / arrays owned by the driver for per-tick bookkeeping and prune long-lived maps in place; avoid spreading a `Map`/`Set` to iterate it unless the loop can reenter and mutate it.
- `snapshot-publish.test.ts` bounds whole-world compositions per burst and per crowd tick, and checks bursts publish the frames per-tick publishing would.


## CI

`p14-perf-smoke` is in `pnpm verify` (Vitest):

- 120 ticks of a tiny in-process scene → `stats` command count is ~5 Hz (not 120), each with a finite `publishMs`; snapshot header `tickIndex` is still 120.
- Obstructed / hidden editor: `RenderScheduler.shouldRender() === false` (zero frames), asserted in `render-core.test.ts`.
- Draw-call ceiling (`DRAW_CALL_WARN_CEILING` 400) as HUD warnings.

No CI test enforces the 8 ms tick budget (`TICK_BUDGET_MS`) or the accounted byte ceilings (`TEXTURE_BYTE_CEILING` 2 GB, `GEOMETRY_BYTE_CEILING` 512 MB); the HUD reports them at runtime.

A16 60fps and on-device reopen remain `p1-device-spikes`. Export unzip-serve-boot-tick is `e2e/p14-export.spec.ts`.

## Renderer baseline fixtures

`e2e/rendering-baseline.spec.ts` loads a primitive room with sixteen eligible point lights, compares sixteen spots with authored 45°/90° inner/outer cones, and reloads points. Each fixture records 30 seconds of viewport frame intervals and CPU timing, shared-Engine GPU query readings, actual drawing dimensions, capability limits, estimated shadow/texture/geometry bytes, resource churn and real canvas captures. Intervals are an Engine-end-frame presentation proxy; GPU queries may include sibling views or repeat the last completed sample, and sampled churn is a lower bound. It runs only through `playwright.perf.config.ts`: `pnpm --silent agent:wait local --script test:e2e -- e2e/rendering-baseline.spec.ts --config playwright.perf.config.ts` (quote `'--'` in PowerShell).

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

The former `Shadow activation handoff` cases in `e2e/framegraph-shadows.spec.ts`
(since removed) measured first and repeated camera-driven point-shadow promotions in PBR and CEL
with the shared allocation ceiling fixed to one cube. Reports included preparation
time, graph build count, selected light and reserved bytes.

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

These staged measurements describe the removed receiver warmup. Handoffs now move
the retained map in place and exchange receiver light indices
([render](../architecture/render.md#camera-driven-shadow-handoffs)). The same
cases now require activation within the first prepared frame, with zero
preparation and frame compilations and no graph builds. Timings have not been
re-measured on native hardware since this change.

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
