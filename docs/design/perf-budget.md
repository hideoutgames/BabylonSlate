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

Per fixed tick, inside the ~3 ms physics share of the combined game-tick budget. Main and SceneLayer physics worlds follow the same rules ([physics](../architecture/physics.md#per-tick-transform-work)):

- Scene Layer worlds: none for a layer without Enable Physics; a physics-enabled layer world is created on first need, skips its native step and readback while it holds no bodies, and is disposed with its layer. Each world's membership pass still scans the World's actor list once (cheap filter rejection for other layers). `scene-layer-runtime.test.ts` guards zero native steps for an enabled layer without bodies. Observed on a shared Linux dev host (Node, Rapier, not a device baseline): native world creation plus disposal ≈ 50–65 µs; 40 dynamic layer bodies tick at ≈ 2.7–2.9 ms in one world vs ≈ 3.2–3.5 ms split across four or eight worlds, within run-to-run noise of ~0.3 ms; four empty enabled layers add ≈ 10 µs per tick.

- One pre-step world-pose composition of physics participants and their ancestors; it is the tick's cycle/shear validation boundary. No other per-tick physics or water pass composes the whole world, except the water and readback fallbacks below (snapshot publishing composes once per published frame; see the worker rule below).
- Body membership scans each eligible actor's components once; only statics with a dynamic or kinematic ancestor scan again to decide hosting. Unchanged collider, rigid-body, mesh-source and static-pose descriptors are compared in scratch and copied only on change.
- Water: no transform work without an enabled water surface (a Landscape alone costs nothing). Otherwise only water, removal-volume, Landscape and buoyant actors plus their ancestors. A parent cycle on a selected chain falls back to composing the whole world. Each script `sampleWater` call evaluates separately: only water surfaces (or the selected water actor's) and cutters plus their ancestors, never buoyant actors, and without replacing the step's evaluation.
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

  | Tier | Realistic transcendentals / roots / value noises / cell evaluations | Stylized Painted transcendentals / roots / value noises / webs | Stylized Toon transcendentals (+ `log2`/`exp2`) / roots / value noises | PBR light loop (Realistic) |
  | --- | --- | --- | --- | --- |
  | Low | 32 / 19 / 3 / 0 | 41 / 21 / 7 / 0 | 24 (+ 6) / 14 / 6 | none (unlit) |
  | Medium | 57 / 24 / 9 / 1 web (+ 1 glitter cell) | 69 / 22 / 13 / 0 | 37 (+ 8) / 15 / 14 | scene light slots |
  | High | 78 + `log2`, `exp2` / 24 / 10 / 3 webs (+ 2 glitter cells) | 87 / 22 / 14 / 2 | 46 (+ 8) / 15 / 14 | scene light slots |
  | Ultra | as High (plus derivative-based glitter widening) | as High | as High | scene light slots |
  | Before tiers (older count: call sites, roots included) | 126 / – / 12 / 2 | 68 / – / 8 / 1 (the earlier single Stylized look) | – | at least four slots |

  - The Painted and Toon columns are counted by script from each look's generated GLSL (`sin`/`cos`/`exp`/`pow`/`log` calls, a vec3 `exp` as three; `sqrt`/`length`/`normalize` calls; `swNoise` and `swWeb` calls). The same script gives the earlier single Stylized look 17 / 11 / 3 and 31 / 13 / 7 and 37 / 13 / 8 against the 18 / 32 / 38 listed for it before, so read the two columns against each other, not to the last unit against Realistic. Painted costs about twice the earlier look's transcendentals and noises on Low (the primary swell gathered per component, a phase-bent copy of the swell for steep views, two ripple families, the lagoon and caustics); Toon about the same transcendentals plus a few `log2`/`exp2` for its footprint-stepped strokes and grids.

  - A value noise is four hashes (about 50 ALU); a Stylized cell evaluation four jittered cell distances (about 120 ALU); a Realistic bubble web (`swWeb`) nine jittered points of a 3 × 3 neighbourhood compared by squared distance, two roots (about 200 ALU); a glitter cell one two-component hash and a lit core (about 25 ALU). Low evaluates only the medium, large and (Realistic) foam-clump noises: its blobs, streaks, breaking zones and Realistic foam lace (two triangle-wave folds and their derivatives, about 15 ALU, no fetch or transcendental) derive from them. Stylized bends its large noise's domain by the medium noise on every tier (about 6 ALU), so colour drifts never show the noise's cell grid. Each Stylized material compiles one look (`SLATE_WATER_TOON`). Painted Low is ALU only: three-tone swell shading from the primary swell, a phase-bent copy of the swell for steep views, two triangle-wave ripple families and a crossing wavelet (no transcendental), the analytic sky, the sun's marks, sheen and halo, the lagoon and caustics, the crest glow, caps and trails, the shore band and one soft lace octave; Medium adds the first capillary octave, three scene-copy sky taps where the view has a copy (the copy refraction already binds: no new sampler), two lace octaves and a far octave, a second wash band, drifting streaks and star sparkles; High adds the second capillary octave, four more sky taps and two bubble webs (`swWeb`) for round foam holes. Toon Low is ALU only: hard bands and two wave tones, two crest isolines, one fixed scale of strokes, dapples and flecks, the shore band, collars, caps and the sun's dashes; Medium adds a trough-side crest isoline, footprint-stepped strokes and dapples, drifting patches, scalloped lobes, the backlit crest band and two scene-copy taps for the horizon tone (where the view has a copy); High adds finer foam lobes and star sparkles. No Stylized tier adds a sampler or a texture fetch beyond the shared terrain and contact fields (and the copy and reflection features, below). Transcendentals run at about quarter rate on Mali and Adreno, so Low's realistic shading is roughly a quarter of the old cost before counting the removed light loop (about 60–90 ALU per light slot plus shadow taps). Open water fetches two textures (terrain and contact fields); the four shoreline taps run only over known terrain with waves. Ultra deliberately costs about the same as High per pixel: its budget goes to render-target features (refraction, reflections, FFT).
  - Realistic look pass (counts above include it): Low adds only ALU and no fetch or sampler: the wave-phase swash (which drops the old wash band's sine) and depth-limited surf, the wet band (one `fwidth`), the cap skirt, the downstream-stretched contact collar (`length` and `normalize` of the current), the far sun-lobe compression and the analytic sky (`normalize` of the reflected ray, two `length`s for its azimuth and `sqrt` of the slope variance, only without an environment or skybox; its powers are multiplications) cost about 80 ALU and four roots, and Low still uses one scalar transmittance, so its transcendental count is unchanged. Uniform-only sun terms (the horizontal sun direction, the low-sun horizon warmth, the share of sunlight entering the water, the light through crests per channel and the glitter's sun visibility) are computed on the CPU (`slateWaterSunShape`, `slateWaterThrough`, `slateWaterSky.w`), not per fragment. Medium adds per-channel transmittance (one vec3 exponential, 3 scalar operations, in place of one scalar one; with the old wash band's sine gone Medium rises by one transcendental), the bubble web (its one web evaluation, at twice the large scale), one glitter cell for the near sun-path sparkles and Subsurface's view-to-sun term. High and Ultra add the finest capillary octave (3 transcendentals, faded within a few metres), the churned and small-bubble webs (three web evaluations in all; the foam grain noise is gone: one value noise fewer), two glitter cells with a `log2` and an `exp2` for the far sun-path sparkles (about 60 ALU) and, only over the contact field's bounds, the wake: two explicit-level taps of the contact field already bound (no new sampler) behind a branch, so open water skips them. The CPU binds five more vec4s per draw (`slateWaterSky`, `slateWaterHorizon`, `slateWaterAbsorb`, `slateWaterSunShape`, `slateWaterThrough`) from per-frame scene data written in place: no allocation and no per-frame material dirtying.
  - Anti-tiling (counted by hand onto the table above, which was counted for the five-component Classic table): every tier evaluates the swell's shared warp with its gradient (3 `cos`, 3 `sin`, about 30 ALU), and the swell now has eight components (sin, cos and `exp` each; Painted twice, with its phase-bent copy): Low still evaluates 3, Medium 6 (was 5 for Classic) and High and Ultra 8 (was 5), so Medium adds 3 and High 9 transcendentals (Painted 6 and 18). Painted's primary swell scale adds two roots. The vertex stage evaluates all eight components plus 3 `cos` for the warp per vertex on every tier (was five). Turning the noise lattices adds 6 MADs; nothing adds a fetch or sampler on Low or Medium.
  - Motion and detail pass (counted by hand onto the table above, like the anti-tiling pass): Toon's crest lines read the swell alone and their dashes from noises stretched across the crests (one more value noise on Low, two from Medium, in place of the chop height and the medium and fine noises they used to reuse), with one more isoline on every tier and a `sqrt` for the crests' speed in pixels; its strokes and flecks ride the water's rest position (no new cost) with one more value noise for the strokes' lifetimes and a `sin` and a `sqrt` per fleck grid for the flecks' lifetimes; its far steps add one `normalize`. So Toon Low adds 2 transcendentals, 4 roots and 2 value noises, Medium and High 2, 4 and 3; Toon also reads the view's scene copy just above the horizon from Medium where a copy exists (2 texel loads, 4 from High: the copy refraction already binds, so no new sampler, and Low reads none). Painted evaluates its second ripple family from Medium (was High) and a third from High: Medium and High add 3 transcendentals each; its sunset gilding by azimuth, short-crested chop and ripple crest touches are multiplications. Realistic's foam web keeps its evaluations (the web's nearest distance in place of its border width, its domain bent by two noises it already evaluates) and its wind streaks keep their three value noises, so its counts are unchanged. Nothing adds a sampler, and Low adds no texture fetch.
  - Zero-valued Sparkles, Crest Foam, Surface Foam or Subsurface compile out on every tier, and uniform-only terms (chop and capillary constants, slope sums, ripple phase, per-asset factors) are computed once per bind on the CPU, allocation-free.
  - Final look pass (counted by hand onto the table above): the shared wave groups add one `cos` and one `sqrt` per swell component evaluated (per vertex: all eight; per fragment: Low 3, Medium 6, High and Ultra 8, plus one `sin` each for the envelope's slope from High). The short-crest envelope adds one `cos` per chop octave evaluated (Realistic Low 2, Medium 4, High 6; Stylized 1, 2, 3). Realistic glitter bends its lattice (two `sin` and two `cos` per glitter level, two levels on every tier) and Low adds one `exp` for its facet weighting; close glints reuse the same field and the foam's strand lace reads the web distances it already computes, so they add no evaluation. Painted's marks keep two `swMark` evaluations (now two footprint octaves, with a `log2`, an `exp2` and the lattice bend's four trigonometric terms each), add a `normalize` for their sun gate and one value noise for the contact collar's width. Toon adds one value noise per extra isoline dash pattern (one on Low, two from Medium), a `reflect` and a `dot` for its smoothed sun column, two `length`s for its oval flecks and, from High, one bubble web (`swWeb`, about 200 ALU) and two value noises for its foam holes in place of one jittered cell. Nothing adds a sampler or a texture fetch, the CPU binds eight more vec4s per draw (`slateWaterSwellGroup0-7`, written in place by `waterWaveShaderConstants`), and nothing allocates or dirties the material per frame.
  - Aperiodic swell pass (no new GPU cost on any tier): the travelling swell warp's drift is folded into each warp term's phase on the CPU in float64 (`waterSwellWarpShaderConstants`, once per bind), and the respaced Classic frequencies and deeper, longer wave groups change only uniform values. The chop's slow phase shift adds one uniform (`slateWaterChopShift`, its cosine and sine from the CPU, and in z and w the chop envelopes' two clocks, which moved there from `slateWaterAbsorb.w`) and two MADs per chop octave evaluated (Stylized Low 1 octave, Realistic Low 2), plus one for Realistic Low's lace copy; each envelope's two-clock phase is one `dot` where one multiply was. Toon's line work adds one `abs` and a `smoothstep` for its flat-top cut. Toon's crest index adds one uniform read, one `floor` and two MADs per fragment (its period count lives in the spare `slateWaterLight.w`, so no new uniform), and the CPU adds a few float64 operations per bind for it. Physics and CPU meshes add four multiplies per warp term per kernel evaluation (∂W/∂t) and two MADs for the moving-point rate terms; no allocation.
  - Dynamic shores pass (counted by hand onto the table above; ALU only on every tier, no new sampler or texture fetch): the shared shore swash runs only within the surf (a branch on the rest shore distance with no derivatives inside, so open water and Global Water away from land skip it). Low evaluates the run-up and drain, the swash cover and front (one `exp`, one `sqrt`, one hash, about 40 ALU); Medium and up add the stranded line, the wet film's age over two cycles and the bores (two more `exp`, two `pow`, two more hashes, about 70 ALU more). Near contacts only (a branch on the contact range), the contact swell adds two `cos` and one `exp` on every look and tier; Realistic adds one `exp` for the clinging ring and, from Medium, one for lee puffs; Painted two `exp`; Toon one from Medium. Realistic's wash band keeps its one `exp` and Toon's Low ring its `sin`; Toon Medium's bore lines replace the ring's `sin`. The CPU binds one more vec4 per draw (`slateWaterSwash`, a few float64 operations in `waterSwashConstants`) and fills the spare `slateWaterContactInfo.w`; nothing allocates or dirties the material per frame, and physics is unchanged.
  - Aerial perspective and swell-fade pass (counted by hand onto the table above; ALU, with one scene-copy fetch from Medium on the sampler Medium already binds; no new sampler or texture). The shared `swAir` is about 20 ALU, one `exp` and one `length`; scene fog adds `CalcFogFactor` and the linear conversion (about two transcendentals) only where fog is on. The haze rate and ramp are computed once per frame on the CPU (`waterHazeConstants`, one `slateWaterHaze` vec4 per draw).
    - Horizon colour (Medium up, views with a scene copy; the same code in all three looks): the sky just above the horizon is read as a horizontal average at the pixel's azimuth (the row at 0.004 elevation: 3 taps at 0 and ±0.035 of the screen width, from High 5 with ±0.07, behind-geometry taps dropped) damped 50/50 by the fixed-point average (2 taps on Medium, 4 from High), so cloud texture never streaks across columns. That is 2 `viewProjection` products (about 32 ALU), one `length` and about 40 ALU of weights and blends, on the sampler Medium already binds; Painted and Toon keep their own fixed taps, Realistic gains them.
    - Realistic: Low about +85 ALU, 1 `exp` and 2 roots (`length`, the level-normal `normalize`); the slope fade is one `smoothstep` and two multiplications per evaluated swell component (3 on Low, 6 on Medium, 8 on High and Ultra, about 8 ALU each) and the reflection lift's `log` and `exp` are unchanged. Medium adds the horizon colour: about +170 ALU in all, 4 roots and 5 fetches (2 fixed, 3 local); High and Ultra about +200 ALU and 9 fetches (4 fixed, 5 local).
    - Painted: about +50 ALU, 2 `exp` (the haze and the crest glow's distance fade) and 1 root on Low. Medium adds the 3 local taps to its 2 fixed ones (+3 fetches, about +45 ALU, 2 roots in all); High and Ultra the 5 local taps to 4 fixed (+5 fetches, about +55 ALU).
    - Toon: about +70 ALU, 1 `exp`, 1 `fwidth` and 1 root on Low (four antialiased band edges and the deep-water mask). Medium adds the 3 local taps to its 2 fixed ones (+3 fetches, about +45 ALU, 2 roots in all); High and Ultra the 5 local taps to 4 fixed (+5 fetches, about +55 ALU).
  - Water blending ([Water blending](../architecture/render.md#water-blending); counted by hand, ALU only on every tier, no new sampler or texture fetch). It compiles (`SLATE_WATER_BLEND`) only into surfaces with a neighbour within the Water Blend Distance, so water that blends with nothing pays nothing.
    - Blending surfaces add one vec4 attribute and varying. Per vertex: three multiplies. Per fragment: about 20 ALU (the swell amplitudes, slope sums, sea state, fade length and FFT gain scale, five colour mixes, and the ownership and union discard folded into the existing cut).
    - CPU: neighbour discovery and per-vertex blend data run only when a body, its pose or revision, or the distance changes, never per frame. A frame without changes costs one 16-float world-matrix comparison per surface while two or more surfaces exist, and nothing with the distance at 0 or a single surface.
    - Global Water with a blending neighbour rewrites and uploads its rest data only for the grid rows within a neighbour's reach (plus one row either side) whenever it recentres; the rest of the grid, positions included, uploads nothing because the recentre moves the grid offset uniform. The kernel runs only for vertices inside a neighbour's reach.
    - Measured on the CPU (NullEngine, Node, this repository's dev container; `updateSceneWater` per frame). A lake beside a river at 8 m: a frame without changes cost 52-60 µs, against 62-99 µs with blending off, so blending adds nothing measurable per frame. Moving the river used to rewrite both surfaces' blend data (2,183 vertices) in one 18 ms frame, against 0.2 ms for a plain translation; the rewrite now runs in chunks (below), and only a first blend or a rebuilt grid still writes in one frame. A Global recentre took 2.7 ms for 5,329 vertices with the lake and river as neighbours, against 0.3 ms without.
    - Budgeted refresh: a moved level body's blend refresh runs in chunks of 32 vertices under a scene-wide 2 ms per-frame budget (a refresh too big for it advances an even share so it lands within 100 ms, or two frames when frames are slow), keeping the previous data until it swaps in and uploads once. Measured the same way (two blending lakes, one dragged 2 cm a frame at a simulated 60 Hz, 240 frames): with 7,442 vertices the peak frame fell from 6-8 ms to about 3 ms, and frames over 2.5 ms from 20 to 2-3; with 24,642 vertices (a refresh of about 16 ms) from 16 ms to 7 ms, spread over three frames a refresh. Mean frame cost is unchanged. Staging buffers add 32 floats a vertex per blending surface, allocated with its first refresh and kept.
    - Measured kernel and query costs (plain Node, no engine, one development machine, default waves, best of several `performance.now()` loops): `evaluateWaterBlend` takes 0.5-0.7 µs beyond a neighbour's reach and 0.8-1.6 µs at the seam (river into lake, lake on ocean, overlapping lakes). A blended query (`sampleWaterBlend`) takes 4.9 µs beyond reach, level with the 4.8 µs plain query. At the seam it took 14-16 µs per body before the stencil change (15-18 µs with 1.5 m, Steepness 1 waves) and takes 8-9 µs now (9-13 µs), averaged over the two blending bodies, one of which does not own the point. A world sample asks every blending body, so a seam point costs the sum. The index's unchanged comparison takes about 1 µs.
    - Worker: a body without neighbours, or a query beyond every neighbour's reach, takes the unblended path. Near a seam a query evaluates the kernel (a rest-base search per participant) at the query point and on a five-point stencil around its first rest point, not at each inversion step; the stencil's neighbours double as the slope taps. That is six or seven kernel evaluations (two for a body that clearly does not own the point) against about fifteen before, with the wave inversion (about five wave evaluations at 1.3 µs) now the larger share. Inside Global Water every body takes this path, since the ocean is a neighbour everywhere.
    - Overdraw: finite bodies extend their grids by half the distance toward finite neighbours, and fragments outside the blended shoreline or owned by the other body are discarded in the cut, before the look code runs.
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
  | High (128², 2 cascades) | up to 6 filtered array fetches (2 per cascade still resolved, 2 more for the first cascade's anti-tiling copy) and about 115 ALU (combined Jacobian, its floor and J⁻ᵀ, the copy's crossfade, and about 15 constant MADs turning each further cascade's point and outputs between its turned frame and the world) | none on Global Water and large volumes (`SLATE_WATER_FFT_VERTEX` 0: their grids cannot resolve the first cascade); on small dense volumes, 6 shear MADs per swell component, about 60 ALU and up to 4 fetches | 1 (6), shared with the vertex stage | 18 passes, 3 MiB |
  | Ultra (256², 3 cascades) | up to 8 fetches and about 150 ALU | 2 fetches (the first cascade) on Global Water's dense core, none on coarser cells, and about 75 ALU plus the shear, compiled only into surfaces whose grid resolves the first cascade (about 15 ALU more per further cascade a dense small volume resolves) | 1 (7) | 22 passes, 18 MiB |

  - Taps follow the footprint: each cascade fades by its shortest wavelength against the pixel footprint (fragment) or the mesh spacing and view footprint (vertex) and then skips its fetches, so distant water pays for the first cascade or none. Ultra's three cascades split High's band more finely rather than extending it, so its first cascade stays resolved about 2.4× farther than High's; its extra fragment taps buy detail at mid distance and its vertex taps buy geometry on dense meshes. The depth pre-pass runs the vertex part only.
  - Until the band is ready, and while it is refused (ledger or the three-simulation cap), every cascade is faded: both stages pay only the fade arithmetic and take no fetch.
  - CPU per draw of a sampling variant: one band lookup, about 20 float operations and 4 vec4 writes (`slateWaterFft`, `slateWaterFftCascade0-2`); no allocation, no per-frame dirtying. The define never follows readiness, so a band becoming ready never recompiles water. The simulation's own CPU and GPU budget (spectrum steps of about 1 ms, passes and memory per tier) is in the FFT notes of [Water](../architecture/render.md#water).
  - Scenes without visible water whose shader samples the band run no simulation and no passes.
- Built-in water displaces a static rest grid in its vertex shader (`SLATE_WATER_GPU_WAVES`): frames upload no water positions, normals or per-vertex wave data. Only a rebuilt grid or a rotated or scaled volume rewrites its static attributes; a translated volume uploads nothing, and a Global Water recentre (a moving or orbiting camera crossing a cell) uploads no vertex data at all: it moves a per-surface grid offset uniform (`slateWaterGridOffset`, one vec4 per draw), with no per-vertex rest data or allocation. The terrain field's per-frame change check compares numbers over a per-scene landscape list, without scanning the scene or building strings. Custom Material water keeps CPU-displaced vertices. A surface that no pass drew last frame and no camera frustum contains skips its CPU vertex work and its terrain and contact refreshes. Water never casts shadows, so visible water no longer forces local shadow maps to re-render each frame. Mesh Density scales cells per side, so vertex-shader work scales with its square (Global Water capped at 192 cells per side). These are design estimates; measure with the Play performance route before quoting savings.
- Water with many bodies (measured; see [Water](../architecture/render.md#water) for the mechanisms). Bodies of one asset share their wave set and per-frame swell constants, a material reuses its bound constants across the draws of one render, contact scans share one candidate list and run in six phases, moving-object contact rebuilds share a 2 ms per-frame budget with a windowed distance transform, and bodies disabled for 2 s release their terrain and contact textures. None of it changes a define or the look: still captures of five views (open sea, island shore, objects, a river into a lake, two lakes) in all three looks at High and Low were identical to the previous revision, except for a few scattered seam pixels in the blend views (at most 0.02% of pixels) that also differ between two runs of the same revision.
  - Scenes: a 160 m-plus landscape under the water, 4 floats in Global Water's shallows, one box meeting each finite body, 200 unrelated meshes behind the camera (contact scans visit them), bodies 20 × 16 m lakes and every fourth a 6 m river, 24 m apart (4 m gaps, so blending at 8 m pairs neighbours), all of one Realistic asset. Moving camera: 0.4 m a frame with a side sway. Bobbing: every float rises and falls 0.3 m and rolls each frame.
  - CPU per frame (`updateSceneWater` plus every water material's `hardBindForSubMesh`), mean ms, NullEngine in Node in this repository's dev container, 240 frames on a simulated 60 Hz clock with the Forward graph's own-pass transparent depth pre-pass (a temporary benchmark harness, not kept in the repository):

    | Scene | Low before / after | Medium before / after | High before / after |
    | --- | --- | --- | --- |
    | Global Water, still camera | 0.27 / 0.25 | 0.12 / 0.06 | 0.13 / 0.15 |
    | Global Water, moving camera | 0.28 / 0.21 | 0.18 / 0.14 | 0.30 / 0.20 |
    | Global Water, 4 bobbing floats | 4.60 / 1.48 | 5.60 / 1.74 | 5.38 / 1.72 |
    | 1 lake | 0.19 / 0.12 | 0.08 / 0.06 | 0.15 / 0.16 |
    | 4 bodies | 0.39 / 0.21 | 0.36 / 0.22 | 0.35 / 0.19 |
    | 16 bodies | 1.22 / 0.55 | 1.06 / 0.43 | 1.14 / 0.49 |
    | 16 bodies, blending at 8 m | 1.07 / 0.53 | 0.98 / 0.53 | 1.02 / 0.51 |
    | 16 bodies, 16 bobbing floats | 23.81 / 5.12 | 23.57 / 5.57 | 27.74 / 5.29 |
    | 32 bodies | 1.72 / 0.67 | 1.86 / 0.70 | 1.88 / 0.80 |
    | 32 bodies, blending at 8 m | 1.92 / 0.84 | 2.14 / 1.01 | 2.02 / 1.17 |
    | 32 bodies, camera turned away | 0.12 / 0.08 | 0.12 / 0.06 | 0.18 / 0.07 |
    | 32 bodies, disabled | 0.02 / 0.05 | 0.02 / 0.03 | 0.03 / 0.03 |
    | Global Water + 16 bodies, blending | 1.34 / 0.68 | 1.37 / 0.61 | 1.43 / 0.66 |

  - Before the change, 32 bodies spent half their CPU recomputing each body's swell, chop and colour constants for every draw (the depth pre-pass and the colour draw each). Every contact surface tested every scene mesh every 100 ms, all in the same frame. With moving objects, the contact distance transform (two passes of closure calls over every window cell, four layers) took 85% of the frame.
  - Uploads: 16 bodies with bobbing floats uploaded 220 KiB of contact texels a frame and now about 120 KiB. Global Water under the moving camera still uploads its positions as it crosses cells (17.7 / 50.7 / 102.9 KiB a frame at Low / Medium / High at 0.4 m a frame). Steady scenes upload nothing, before and after.
  - Unchanged and already shared: 32 bodies of one asset compile one water effect per pass variant (Babylon shares effects by defines; a blending variant adds one), and FFT simulations are shared by layout (3 MiB at High however many bodies). Each body keeps its own material (its own terrain and contact fields, bounds and blend data bind per draw) and draws twice (depth pre-pass and colour): 32 bodies are 64 water draws. Memory with 32 bodies at Medium: 0.66 MiB of vertex data, 1.41 MiB of terrain fields and 0.82 MiB of contact fields. 32 disabled bodies held 1.38 MiB and 0.73 MiB of those textures and now release them after 2 s.
  - Allocation: water binds and the water update no longer allocate per frame in steady scenes (colour arrays, spread uniform arguments, per-frame binding data and removal lists, per-name strings); a V8 sampling heap profile of 32 bodies attributes under 3 KiB a frame to water code, most of it boxed numbers.
  - Software renderer: whole frames (CPU, then a one-pixel read that waits for the GPU) through `SceneRenderCoordinator`, Chromium headless with SwiftShader WebGL2, 640 × 360, 40 frames after warm-up (a temporary browser harness, not kept in the repository). Median CPU ms, then median / p95 frame ms, before → after. SwiftShader shades on the same CPU cores, so frames are fragment-bound and CPU savings show only in part; draws per frame are unchanged.

    | Tier | Scene | CPU ms | Frame ms (median / p95) |
    | --- | --- | --- | --- |
    | Low | Global Water | 3.16 → 2.59 | 158 / 203 → 144 / 176 |
    | Low | Global Water, 4 bobbing floats | 13.40 → 7.02 | 150 / 188 → 139 / 166 |
    | Low | 16 bodies, 16 bobbing floats | 60.54 → 8.34 | 131 / 170 → 79 / 98 |
    | Low | 32 bodies | 9.98 → 7.95 | 108 / 163 → 98 / 125 |
    | Medium | Global Water | 3.07 → 3.10 | 215 / 269 → 196 / 216 |
    | Medium | Global Water, moving camera | 4.27 → 4.12 | 226 / 269 → 197 / 231 |
    | Medium | Global Water, 4 bobbing floats | 14.17 → 7.29 | 239 / 290 → 209 / 244 |
    | Medium | 4 bodies | 3.74 → 3.02 | 77 / 95 → 72 / 86 |
    | Medium | 16 bodies | 7.47 → 5.36 | 103 / 129 → 96 / 115 |
    | Medium | 16 bodies, blending at 8 m | 8.18 → 5.39 | 135 / 166 → 122 / 145 |
    | Medium | 16 bodies, 16 bobbing floats | 61.74 → 10.01 | 145 / 187 → 97 / 127 |
    | Medium | 32 bodies | 12.34 → 8.17 | 133 / 165 → 123 / 157 |
    | Medium | 32 bodies, blending at 8 m | 11.83 → 7.66 | 202 / 250 → 180 / 200 |
    | High | Global Water | 2.85 → 2.45 | 317 / 382 → 304 / 334 |
    | High | 16 bodies, 16 bobbing floats | 53.63 → 10.14 | 180 / 213 → 140 / 161 |
    | High | 32 bodies | 9.90 → 8.43 | 205 / 261 → 204 / 260 |

  - Moving bodies and re-enabling (review pass; same harness, 240 frames at 60 Hz). A 20 × 16 m lake sliding 2 cm a frame beside Global Water, blending at 8 m (its blend data already refreshed at most every 200 ms), refilled its terrain field and re-cut its contacts every frame. Both now run at most every 150 ms, and the field samples rest heights every fourth cell. 32 bodies disabled for 2 s and enabled together used to rebuild every field in their first frames; they now keep their CPU data while released and re-upload two a frame.

    | Scene | Low before / after | Medium before / after | High before / after |
    | --- | --- | --- | --- |
    | Lake moving beside Global Water, blending, mean ms | 30.9 / 4.71 | 33.0 / 2.58 | 32.8 / 2.48 |
    | Same, p95 / max ms | 42.2 / 53.0 → 17.5 / 25.8 | 45.3 / 67.8 → 10.0 / 14.2 | 48.0 / 80.8 → 10.0 / 14.5 |
    | Same, texture KiB a frame | 75.2 / 6.8 | 75.2 / 7.1 | 75.2 / 6.8 |
    | 32 bodies re-enabled together, worst frame ms | 136.6 / 5.3 | 116.6 / 5.0 | 137.3 / 7.4 |
    | Global Water + 4 bodies blending, camera moving, mean ms | — / 0.99 | — / 2.31 | — / 3.11 |

    The moving camera uploaded 37 / 109 / 221 KiB of vertex data a frame at Low / Medium / High (Global Water's position stream and blending rows as it recentred; measured before the grid offset, which removed the position stream's 18 / 51 / 103 KB, so only the blending rows remain). Shader costs of the same pass (ALU only, no sampler or fetch; nothing allocates or dirties the material per frame): surges are folded into each swell component's phase on the CPU in float64 (no GPU cost; physics adds two `sin` and two `cos` per component per evaluation time, cached per wave set); the chop's second phase tone adds one `sin` and one `dot` per chop octave evaluated; shore bores add a `normalize` and a `dot` inside the swash branch; Realistic and Painted's water-covered bank fade adds one `smoothstep`; Painted's and Toon's far-row fades add two `smoothstep`s and two MADs; reflection hits add one `smoothstep` only on a hit.
  - Not done, and why: Global Water keeps its grid (a dense core and graded outer cells; at Medium 5,329 vertices) rather than camera-centred rings, which would cut its vertex work but change its silhouette and its spacing filter far out; vertex work is small next to its fragment shading on every tier. Deferring its recentre until the camera had moved a few cells cut the moving camera's uploads about sixfold, but it shifted where the dense cells end ahead of the camera and changed the mid-distance glitter (up to 6% of pixels in a forward-drifting clip), so it was dropped. Without it, clips of a drifting and of a sideways-tracking camera over Global Water are bit-identical to the previous revision. Bodies are not merged into shared materials or batched draws (per-body fields and blend data). A moved blending body's blend refresh starts at most every 200 ms while it keeps moving and is spread over frames (2 ms a frame, landing within 100 ms; a refresh above that takes an even share of its chunks, so a very large grid still costs several ms for a few frames); the 14-26 ms single-frame peak of the moving-lake scenario below is from before this. A first blend, a rotation out of level or a new grid extension still write in one frame. The contact budget delays, it does not shrink, a single large rebuild.
  - These are desktop measurements. Profile Medium water on the A16 iPad and Low on a budget Android phone before quoting device savings.
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
- Build the frame's live guid index (`navFrameActors`) only when behaviour trees or a navmesh can read it, with a plain loop.
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
