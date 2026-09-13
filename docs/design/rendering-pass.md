# Rendering pass: stability, conventional lighting, baking, and GI

**Status: planned; rendering implementation has not started.** Investigation baseline: `b2555166`, Babylon.js **9.20.0**, September 2026. This is the delivery tracker for the large rendering pass and supplements the authoritative [engine plan](../engineplan.md). Complete checkboxes only when implementation, focused verification, and a merged PR are recorded.

## Accepted requirements

| ID | Requirement | Milestone |
| --- | --- | --- |
| R1 | Fix settings-close crash on iPadOS 26 PWA after Ultra and Shadow Casters 4 → 16, mainly point lights | M1–M2 |
| R2 | Restore blocking Scene Loading for every actual scene load/reload, including settings-driven transitions | M1 |
| R3 | Quality-dependent shadow capacity; nearby lights follow the possessed camera with stable handoff | M2 |
| R4 | White normal light billboards; yellow/red communicate state, never authored lighting hue | M3 |
| R5 | Shadows and all new Scene Details rendering override categories collapse and start closed | M3 |
| R6 | Ideal sustained 60 fps on the 11-inch A16 iPad; CEL and PBR remain flagship shading modes | All; M9 qualification |
| R7 | Conventional / Global Illumination is independent of CEL / PBR | M4 |
| R8 | Hide inactive lighting-mode settings and preserve their authored values | M4 |
| R9 | Complete normal rendering features before advanced GI | M5–M7 precede M8 |
| R10 | Light baking and Static / Stationary / Dynamic light options | M7 |
| R11 | Reflections and applicable rendering features connect to supported Material domains | M5–M8 |
| R12 | Implement GI according to Babylon APIs, with capability limits and meaningful tests | M8–M9 |

The editor permits **one normal Scene document**. Multiple normal Scene tabs are not a crash precondition. Previews and Play still share the project Engine and consume resources. No optional 30 fps rich-effects mode is requested. Existing editor viewport caps remain distinct from the 60 fps Play/player target.

## Investigation findings

These are source findings, not a reproduced on-device crash diagnosis. File names below identify implementation anchors to revisit when each milestone begins.

| Finding | Anchors | Consequence |
| --- | --- | --- |
| Settings commit on close; the viewport settings key recreates its scene handle | Editor `settings-modal.tsx`, `document-context.tsx`, `scene-viewport-load.ts`, `viewport-panel.tsx` | Diff/apply compatible changes; coordinate necessary rebuilds |
| Synchronous scene/light/shadow realization precedes the loading effect and asset error handling | Render `create-engine.ts`, `editor-scene-sync.ts`, `scene-illumination.ts` | Modal must paint before expensive work starts |
| Readiness tracks engine generation; errors can still mark loading complete | Viewport panel and load helper | Use per-transition identity and explicit failure states |
| Restore observers outlive handles; async warming can finish after disposal | `create-engine.ts`, viewport panel | Remove observers and reject stale completion |
| All presets permit four local shadow lights; manual capacity survives preset changes | Core `shadows.ts`, quality resolver | Separate automatic capacity from a manual upper limit |
| Ultra uses four 4096 directional cascades and 2048 local maps | Core shadow profiles | Count alone cannot bound memory or point-light work |
| Selection already uses active-camera position, priority/intensity/distance and incumbent bonus | Render `shadow-controller.ts` | Refine existing selection and hysteresis |
| Generator keys include unrelated settings/camera identity; maps refresh continuously | Shadow controller | Reuse compatible maps and add valid dirty policies |
| Enabled direct lights grow forward shader capacity without a spatial budget | `scene-lighting.ts` | Evaluate clustering and bound fallback shader cost |
| Normal billboard tint uses authored RGB | `editor-billboard.ts` | Replace with the state palette |
| Resolution feedback uses render CPU time; texture accounting can disagree with upload format | `create-engine.ts`, `hardware-scaling.ts`, `ktx2-transcoder.ts`, `resource-cache.ts` | Measure GPU/presentation and actual formats |
| Environment assignment exists, but environment-specific import/loading is incomplete | `scene-illumination.ts`, cache and asset importers | Complete import through exported-player consumption |
| PBR graph reflection hooks exist; CEL environment response and advanced inputs are incomplete | `material-compiler.ts`, `cel-surface.ts`, `cel-material.ts`, shader catalog | Explicit native/graph material parity work |

At Ultra, **16 eligible point shadow lights**, not just a capacity field set to 16, imply 96 local shadow faces. RGBA half-float color attachments alone are approximately **3 GiB**, before depth, sun, textures, geometry and previews. Pinned Babylon attachment choices put sun plus local shadow attachments around **4.5 GiB or more**, depending on depth storage. This is a strong GPU/process memory-pressure hypothesis, not measured Safari residency or proof of the crash cause. Capture console/context-loss evidence and application resource accounting on the reported device before declaring the cause confirmed.

Preserve working spatial caster indexing, conservative animated bounds, static index partitions, shared Engine ownership and the already-fixed floating-origin freeze path. Existing Play/player loading also needs scrutiny: model-ready acknowledgement is weaker than asset/shader/first-frame readiness, and player warming is not consistently per transition. Runtime **Game Instance** is unrelated to the global-illumination acronym and its loading/tick contract must remain intact.

## Settings and architecture contract

Project Settings → Rendering has two independent selectors: **Lighting Mode: Conventional / Global Illumination** and **Shading Mode: PBR / CEL**. All four combinations are required. Add a distinct versioned lighting-mode field; migrate the existing shading-mode field without changing its meaning.

| Group | Conventional | GI |
| --- | --- | --- |
| Quality, resolution, shadows, textures, environment, reflections, output color, AA | Shared | Shared |
| Conventional direct-light strategy/tuning | Visible | Hidden; values retained |
| GI source, contributor budget, RSM quality/diagnostics | Hidden; values retained | Visible |
| Bake authoring and bake status | Available | Available |
| CEL/PBR-specific style controls | According to shading selection | According to shading selection |

Use shared settings plus separately persisted conventional/GI blocks, with exact names following core schema conventions. GI still requires direct lighting and shadows: reuse the same services instead of duplicating lights. Conventional may consume baked/environment lighting; GI adds the selected live diffuse-bounce path. Product names do not redefine whether baked illumination is indirect.

Preserve project → scene → local preview preference → session override precedence. Hidden values are neither reset nor implicitly disabled. Reset deletes an override key and resumes live inheritance. Presets select automatic budgets; a manual upper limit is visible and always subject to effective admission. Legacy normalization may have erased whether capacity four was intentional: document this ambiguity and expose Auto/Manual rather than silently claiming to reconstruct intent. Older scenes default to Conventional and retain their CEL/PBR appearance.

A scene-owned rendering coordinator resolves settings and owns shadow, environment, reflection, GI and post-process services. The project Engine ledger accounts all clients and transient overlaps. Services have explicit apply/readiness/invalidate/dispose behavior. Materials consume named shared resources; they do not create individual GI managers, reflection captures or geometry buffers. Allocate auxiliary depth/normal targets only for enabled consumers and share compatible targets.

Core owns serializable data/commands; render owns Babylon objects; existing asset/storage layers own persistence; React remains in editor/UI packages. Runtime/player resolve identical settings. Preserve command-bus boundaries, one Engine per project, and the removed-HUD restriction.

## Performance policy

60 fps gives **16.67 ms per presented frame**. CPU/GPU overlap, so do not simply add their timings. Preserve the existing combined worker tick target below 8 ms. Tune GPU work with headroom, then qualify sustained performance.

UL reports approximately 56 fps Wild Life, 63 fps Unlimited, and 16 fps Extreme for the A16 iPad. These are different native Metal workloads, not browser guarantees or sustained Babylon measurements. They support treating A16 as capable while measuring this renderer directly. [UL device results](https://benchmarks.ul.com/hardware/tablet/Apple+iPad+(2025)+review), [workload methodology](https://support.benchmarks.ul.com/support/solutions/articles/44002135606-wild-life-graphics-test).

Safari/iPadOS 26 supports WebGPU, but this repository currently constructs WebGL Engines. Retain WebGL2 as the validated baseline and separately prototype WebGPU; custom GLSL, native WGSL and CEL compatibility require tests. Backend migration must not delay crash repairs. [WebKit Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

Measure presented intervals, median/p95/p99, missed-vsync rate and longest stalls; CPU render/worker time; valid GPU timing when available; loading separately; draw calls, shadow faces/passes, shader light slots, live/peak estimated bytes and allocation churn. Reject disjoint GPU samples and use presentation feedback when GPU timing is unavailable. Shared-Engine timing must not be misattributed to one viewport.

Account actual upload formats, block compression, mip levels, cube faces, depth, array layers, previews and temporary copies. Safari has no universal reliable VRAM budget: estimates must be labelled. Admit memory, pass and sampler costs **before allocation**, reserving headroom for all resource categories. Query capabilities; do not assume a fixed A16 sampler count.

Start shadow experiments with 1/2/4/8 local lights and 256/512/1024 maps, independently testing higher settings only when total admission permits. Sixteen spots and sixteen points are different workloads. Final tier tables come from device results; these are experiment ranges, not shipping caps. High/Ultra still display requested versus effective settings and limiting reasons.

Dynamic scaling uses valid GPU/presentation pressure with hysteresis/cooldown, ignoring intentionally capped/hidden periods. Define deterministic effect-quality/update-frequency relief without rewriting authored values. A rich GI preset that misses 60 fps remains visibly unqualified for the A16 target.

## Milestones

Dependencies: **M0 → M1 → M2 → M3/M4 → M5 → M6 → M7 → M8 → M9**. Validate every milestone; M9 is sustained integration qualification, not the first device test. Split large milestones into reviewable PRs with coherent contracts and consumers.

### M0 — Baseline and reproducible fixtures

- [ ] Capture settings, Babylon capabilities, actual render dimensions and device/browser version.
- [ ] Use runtime primitives for an indoor point-light room, mixed-light camera route, sun/cascade scene, material chart, moving occluders, reflective surfaces and repeated-model workload.
- [ ] Reproduce Ultra + 4 → 16 → settings close with one normal Scene; vary eligible point count and compare spots.
- [ ] Capture baseline counters/loading behavior and focused failing regressions for confirmed bugs.

Exit: reproducible source failures and honest device evidence. Unknown crash mechanism remains labelled unknown.

### M1 — Settings application, loading and recovery

- [ ] Implement transition states: preparing, realizing, loading assets, warming shaders, presenting first frame, ready, failed/cancelled.
- [ ] Acquire blocking UI before document I/O/synchronous realization; yield for modal paint and chunk long work so progress/cancellation remain responsive.
- [ ] Diff effective settings and apply compatible light/material/effect changes in place. Rebuild only as needed; preserve selection, camera, dirty state, undo and simulation state as applicable.
- [ ] Settings requiring reconfiguration show blocking rendering progress; actual reloads use Scene Loading. Closing unchanged settings does not reload.
- [ ] Tokenize same-Engine reloads, rapid switches, mode changes and context restoration; stale tasks cannot mark a new scene ready.
- [ ] Await the complete asset-assignment batch, texture readiness, shader warming and controlled first render. Give that render a narrow permit because the modal pauses normal rendering; avoid readiness deadlock.
- [ ] Handle synchronous and async failures, release partial allocations and provide recovery. Never mark failed loading ready from `finally`.
- [ ] Remove all restore observers on disposal; reject disposed warming callbacks. Timeouts must not be mistaken for cancellation of underlying work.
- [ ] Share readiness semantics with Play/player; preserve Game Instance ticking, stale-ack rejection and Stop behavior. Stop resumes an existing editor scene without needless reload.
- [ ] Restore only live handles, with bounded resource rebuilding and no obsolete cache-release callback.

Exit: repeated open/reload, settings close, Play/Stop, failure/recovery and mode switches show correct progress and no stale ownership or false success.

### M2 — Quality-driven shadows and camera selection

- [ ] Add per-quality Auto capacity and bounded Manual upper limit, including serialization/migration.
- [ ] Admit maps against memory, face/pass and sampler budgets before construction; reserve room for previews, materials, GI/reflections and transition peaks.
- [ ] Use possessed camera in Play, editor camera otherwise, and an explicit active free-camera inspection override. Cover possession and fallback changes.
- [ ] Prefer nearest relevant lights by default. Keep authored priority explicit, deterministic ties and distance hysteresis/dwell. Influence/receiver culling must retain off-screen casters that shadow visible receivers.
- [ ] Distinguish disabled, non-illuminating, no-shadow-request, distance-limited and budget-limited states; retain single-sun ownership.
- [ ] Reuse compatible generators across camera/scalar changes; structural format/resolution/type changes alone require allocation changes. Any pool has bounded retention included in the ledger.
- [ ] Validate Babylon single-channel shadow formats with point/spot/CSM and selected filters before claiming savings. Report effective filter fallback, including point Poisson behavior.
- [ ] Add mobility-aware dirty maps and staggered refresh. Moving lights/casters, animated alpha/deformation and cascade coverage invalidate correctly; camera-dependent sun maps cannot freeze indefinitely.
- [ ] Preserve spatial index/partition optimizations and avoid per-light whole-scene scans or per-frame allocation.
- [ ] Recover from allocation/context failures through bounded downgrade and cleanup, retaining authored values.

Exit: camera handoff is stable, lowering quality lowers effective cost after manual 16, and repeated movement does not continually recreate maps.

### M3 — Billboards and collapsible overrides

- [ ] White means enabled/operating as configured, including valid baked Static lights and lights intentionally without shadows. Yellow means requested contribution limited/unavailable; red means disabled/effectively disabled. Explain state in accessible text/tooltips.
- [ ] Stop tinting billboards with authored RGB; retain RGB in light data and its color field.
- [ ] Shadows starts closed in Scene Details → Post Processing. Every added override group follows this pattern: Bloom, LUT, Color Correction, Gamma, Reflections, GI and other applicable categories.
- [ ] Reuse compact Button/disclosure/FieldSet controls, keyboard/touch behavior and `aria-expanded`. Collapse is UI state, independent of override/reset data.
- [ ] Search includes shadow/effect labels, temporarily reveals matching groups and restores manual collapse state after clearing. Update the component catalog for reusable composition changes.

Exit: closed initial categories, searchable fields, correct inherited reset and white/yellow/red states in CEL/PBR.

### M4 — Independent lighting modes

- [ ] Implement the settings contract, validators, versioned migration, undo/redo, save/reopen and export resolution.
- [ ] Hide inactive controls in Project Settings/Scene Details without deleting saved values.
- [ ] Resolve capabilities/effective policy consistently across scene, material/prefab previews, Play and player.
- [ ] Use M1 transitions for switches; release inactive mode resources while preserving shared assets.
- [ ] Report unsupported feature fallback explicitly without rewriting authored mode selection. GI remains gated until M8 integration is ready.

Exit: all four lighting/shading combinations round-trip safely with independent values and correct visibility.

### M5 — Conventional lighting, environments and efficiency

- [ ] Complete ENV/prefiltered DDS import, validation, cache loading, metadata, dependencies and export. Evaluate HDR conversion as authoring work rather than repeated iPad runtime prefiltering.
- [ ] Add environment intensity/orientation and correct linear/HDR decoding. Shared textures must not make one scene mutate another's settings.
- [ ] Finish native/graph/imported PBR environment response and deliberate CEL environment response preserving bands/colors.
- [ ] Prototype Babylon clustered eligible unshadowed point/spot lights, with separately budgeted shadow lights and sun. Promotion/demotion must not double contributions.
- [ ] Validate 9.20 float-render/float-blend capabilities, attenuation and unsupported light features. Clustered lights do not supply shadows; unsupported lights use bounded conventional fallback. Do not silently alter physical falloff.
- [ ] Test NodeMaterial view inputs and CEL ramp hooks; avoid wholesale material replacement solely for clustering.
- [ ] Fix KTX2 routing so execution thread does not unnecessarily force RGBA. Account actual compressed/fallback upload and preserve suitable compressed export payloads.
- [ ] Avoid unnecessary transition cache eviction/reupload. Evaluate instances/thin instances for eligible repeated models with picking, overrides, culling and animated fallback preserved.

Exit: environment import → preview → scene → Play → exported consumption works; clustering has measured benefit and CEL/PBR parity.

### M6 — Conventional effects and Material connections

- [ ] Establish one linear-light/output-color contract across native/graph CEL/PBR. Specify built-in effect ordering relative to the existing authored post-process stack.
- [ ] Add opt-in scalable Bloom, Exposure/Tone Mapping, Color Correction, LUT and artistic Gamma. Output transfer happens once; artistic gamma is not accidental double sRGB conversion.
- [ ] Evaluate FXAA as an inexpensive AA baseline; compare alternatives independently. Keep iPad MSAA off until measurements justify changing it.
- [ ] Add material AO first, then optional reduced-resolution SSAO with shared buffers; avoid indiscriminately multiplying baked occlusion and SSAO.
- [ ] Add local reflection capture/influence, refresh-once/on-dirty scheduling, bounded update work and roughness-correct prefiltered PBR sampling.
- [ ] Evaluate optional SSR after probes: shared compatible buffers, bounded scale/steps and environment/probe fallback for off-screen information. State transparent-surface limits.
- [ ] Implement the domain matrix below, including graph validation, previews, functions, asset dependencies and export.

Exit: disabled effects allocate no unnecessary targets; resize, camera/mode switches and effect toggles retain one owner and consistent color output.

### M7 — Light mobility and baking

Babylon supports lightmap consumption, but the 9.20 source investigation found **no complete native scene-lighting baker**. Its official workflow uses Blender. Static/Stationary/Dynamic is BabylonSlate authoring policy, not a native Babylon light enum. RSM and `MeshUVSpaceRenderer` are not replacements for transport solving and UV unwrapping. [Official lightmap workflow](https://github.com/BabylonJS/Documentation/blob/master/content/guidedLearning/lightmaps.md).

| Mobility | Direct light | Indirect light | Change policy |
| --- | --- | --- | --- |
| Static | Baked on static receivers; no equivalent realtime light/shadow slot | Baked surface data/probes | Source or relevant scene edits invalidate bake; moving objects receive baked probes, without new light-specific dynamic shadows |
| Stationary | Realtime direct/highlights and budgeted shadows | Initially baked indirect only | Fixed placement; color/intensity changes affect direct light but stale indirect requires rebake |
| Dynamic | Realtime direct and budgeted shadows | Eligible live GI in GI mode; no baked source contribution initially | Moves freely; can receive existing baked/environment illumination |

- [ ] Default existing lights to Dynamic. Separate mesh bake participation from light mobility; define static receivers/occluders and dynamic/skinned/morphing exclusions.
- [ ] Specify non-overlapping UV2, gutters/mip padding, atlas scale/offset per instance, density/resolution limits and attribute preservation when seams duplicate vertices. An unwrap library is not a baker.
- [ ] Support imported bake manifests/maps first; then deliver integrated **Bake Lighting**. Import-only support does not complete this requirement.
- [ ] Select a maintained/licensed bake provider through a bounded prototype: direct/indirect separation, diffuse bounce, UV packing, material closure, memory, progress/cancel and browser/desktop feasibility. Avoid a new transport solver inside the render loop.
- [ ] Define a platform-neutral bake job and ProjectStorage boundary. A desktop adapter can produce offline iPad runtime assets, but does not fulfill self-contained iPad authoring; consult before making external tooling mandatory. A browser worker/WASM provider is a separate capability to validate.
- [ ] Reuse generation/hash/cancellation patterns from audio/navigation baking, not their geometry/solver assumptions. Bake is explicit, never automatically started on settings close or ordinary Save.
- [ ] Store versioned manifests/chunks with scene/component/model-primitive identity, geometry/UV/transform/material/light/environment hashes, baker/settings version, atlas/probe GUIDs and encodings. Never bind persisted bakes using Babylon `uniqueId`.
- [ ] Commit output atomically only if inputs still match. Support cancellation, stale/failed/valid status, last-valid output ownership and incremental rebake where supported. Bound authoring work separately from viewport resources.
- [ ] Prefer a specified linear diffuse-irradiance representation before CEL bands and output mapping, with albedo applied once. Native PBR lightmaps add decoded RGB late; implement explicit native/graph adapters rather than assigning arbitrary irradiance as `lightmapTexture` and assuming equivalent math.
- [ ] Define restricted bake material evaluation; unsupported time/view-dependent/custom shader behavior needs a proxy or an actionable rejection. Material albedo/emission changes invalidate bounced lighting.
- [ ] Include bounded spatial irradiance probes for moving receivers, with interpolation/leakage tests near walls. Lightmaps cannot follow animated objects. Static lights requiring moving direct shadows should be Stationary.
- [ ] Eliminate duplicate direct/indirect terms across baked/realtime receivers. Stationary V1 bakes indirect only; do not promise runtime-recolorable combined atlases or shadowmask blending without the necessary representation/overlap limits.
- [ ] Define unbuilt/stale fallback explicitly: preserve useful editor preview with visible status; never silently drop all Static illumination or represent stale bakes as current. Validate duplication, prefab instances, reimport, missing data, reopen and export without runtime baker dependency.

Exit: bake a point-lit scene, reopen/export, verify static and moving receivers, invalidate each relevant input and measure runtime savings versus dynamic lighting. Record bake size/time separately.

### M8 — Babylon real-time GI

Integrate **ReflectiveShadowMap → GIRSM → GIRSMManager** using pinned compatible APIs. The documented RSM path supports directional/spot contributors, sampled diffuse bounce and filtering; it has leakage and large-scene limitations. It is not arbitrary-light occlusion-correct GI. [Babylon RSM documentation](https://doc.babylonjs.com/features/featuresDeepDive/lights/rsmgi/).

This limitation is specific to Babylon's shipped implementation, not a claim that point-source RSM is impossible. The [9.20 constructor and targets](https://github.com/BabylonJS/Babylon.js/blob/9.20.0/packages/dev/core/src/Rendering/reflectiveShadowMap.pure.ts#L108) accept `DirectionalLight | SpotLight` and use 2D targets. RSM's virtual point lights are bounce samples, not authored `PointLight` sources. A true omnidirectional extension requires its own capture, sampling, energy and performance validation.

- [ ] Establish a runtime-primitive parity fixture against Babylon's documented setup before editor integration.
- [ ] Confirm MRT/texture/filter capabilities, imports and lifetime behavior in 9.20. Any engine upgrade is a separately justified change with affected regression coverage.
- [ ] Budget GI contributors independently and restrict each RSM's mesh set. Point lights retain direct/shadows and baked indirect; do not synthesize six GI spots as an undocumented workaround.
- [ ] Start experiments with one contributor, reduced GI dimensions, modest RSM/sample counts and inexpensive bilateral filtering. Sweep on A16; exclude full-texture sampling and expensive full-size/quality blur from the baseline.
- [ ] Separate light-space RSM caching from camera-space output refresh. Static source maps invalidate on geometry/material/light changes; camera movement still changes screen output. Animated contributors invalidate correctly.
- [ ] Integrate native PBR and graph/native CEL/PBR explicitly. Babylon plugins do not prove custom NodeMaterial compatibility. Inject indirect energy at the correct stage and preserve CEL controls.
- [ ] Define contribution masks preventing baked and live bounce from counting the same source twice. Initially exclude baked sources from live RSM or explicitly separate their receiver/source channels.
- [ ] Use GI-compatible geometry-buffer paths for SSAO/SSR instead of incompatible pre-pass configuration. Share resources and release after the final consumer.
- [ ] Cover resize/resolution scaling, late material loading, possession, transitions, context loss and shutdown; inactive GI owns no unnecessary targets/plugins/observers.
- [ ] Expose bounded GI controls only in GI mode; advanced controls live in closed disclosures. Explain eligible sources and effective limits.
- [ ] Test thin walls/leakage, moving occluders, noise, flicker/disocclusion and large-world bounds. Document RSM limits honestly rather than promising they are removed by baking.

Exit: visible validated bounce in GI + CEL/PBR, Conventional unchanged, no duplicate energy, correct point-light limitation, safe fallback and measured incremental cost. Implemented GI and A16-qualified rich presets are separate acceptance claims.

### M9 — Sustained integration qualification

- [ ] Run fixed routes at least 20 minutes after warm-up on the actual A16 PWA; record brightness/power conditions and early/late thermal behavior.
- [ ] Compare Conventional/GI × CEL/PBR using identical content/render size: indoor points, mixed lights, sun, baking, dynamic receivers, reflections and representative effects.
- [ ] Repeat settings-close, preset/mode switches, scene reload, Play/Stop, context recovery and background/resume; live counts return to baseline without monotonic growth.
- [ ] Validate offline reopen and exported-player behavior with missing/corrupt environment/bake/LUT data. Packaging/publication still requires separate authorization.
- [ ] Publish measured preset tables, real app captures and limitations in render/performance documentation.
- [ ] Mark 60 fps qualified only from sustained presented-frame evidence. Desktop screenshots, native benchmarks and CI worker smoke tests are not that evidence.

## Material domain matrix

| Resource | Lit Surface PBR | Lit Surface CEL | Unlit Surface | Post Process | Particle |
| --- | --- | --- | --- | --- | --- |
| Environment/probe reflection | Roughness-aware input and scene default | Explicit stylized input/strength | Explicit texture color only | Already in scene color; optional declared buffer | Only supported lit path or explicit texture sampling |
| AO | Indirect occlusion | Deliberate indirect response | No automatic lighting | Supported SSAO composite | Supported lit path only |
| Baked lightmap/probes | UV2/binding and linear indirect adapter | Indirect/style adapter | No automatic lighting | Optional diagnostics only | Probe reception only if implemented; no mesh-map assumption |
| RSM GI | Indirect diffuse adapter | Indirect diffuse/style adapter | None | Optional debug buffer, no second GI addition | Unsupported initially unless explicitly implemented/tested |
| Bloom/LUT/output | HDR/emission feeds scene pipeline | Same without washing out bands | Emission may bloom | Ordered effect/color-space contract | Through scene output |
| Clear coat/sheen/anisotropy/transmission | Evaluate missing graph inputs against native support | Only deliberately supported semantics | Not lighting lobes | Not lobe inputs | Reject unsupported lobes |

Reflection overrides fall back to scene policy. Resource nodes carry asset/type/color-space metadata through functions, preview, serialization and export. Validate invalid-domain connections and missing/late-loaded resources. SSR is a scene effect, not a cubemap socket. Do not expose controls that compile but have no effect.

## Targeted test plan

Use existing tests as anchors and extend observable coverage, rather than duplicating cases or testing mock setup. Names below are scope guidance, not assertions that existing tests cover the new requirements.

| Work | Focused test anchors / cases | GPU/device proof |
| --- | --- | --- |
| Lifecycle | `scene-viewport-load.test.ts`, viewport/settings tests, `create-engine.play.test.ts`: same-Engine reload, paint-before-realize, failure, stale completion | Correct modal and first-frame order, repeated recovery |
| Runtime load | `game-instance-scene.test.ts` tick/stale-ack/stop; Play/player transition cases | Complete assets/shaders before ready |
| Shadows | Core `render-quality.test.ts`, `shadows.test.ts`, render `shadow-controller.test.ts` | Point/spot budgets, nearest-camera handoff, allocation reuse |
| Caster correctness | Affected `shadow-spatial-index.test.ts` cases | Off-screen casters, deformation, moving cascades |
| UI/modes | Billboard, Scene Details search/collapse/reset, settings retention/migration | Touch/keyboard and palette states |
| Resources | `ktx2-transcoder.test.ts`, `resource-cache-texture.test.ts`: actual format and readiness | ASTC/fallback, reload/export behavior |
| Materials | `scene-lighting.test.ts`, compiler/domain tests, existing CEL rendering e2e | Native/graph/imported shader and pixel parity |
| Baking | UV/manifests, input invalidation, cancellation/atomic commit, dependencies | Primitive bake, moving probes, no duplicate energy |
| GI/effects | Capability/lifecycle plus explicit shader/pixel browser cases | Bounce/reflections/color, resize/recovery, A16 timing |

Use primitive/numeric fixtures and backend-appropriate visual tolerances. NullEngine tests cannot prove shader compatibility. Local runs select explicit files/cases through the shared admission runner with `BL_TEST_PROFILE=shared`; no automatic full-suite/preflight expansion. Required CI remains unchanged. Record command, revision, result and unavailable hardware checks honestly.

## Decisions and consultation gates

| Decision | Position | Gate |
| --- | --- | --- |
| Independent lighting/shading modes | Confirmed | Round-trip/visibility tests |
| Normal features before GI | Confirmed | M1–M7 foundations |
| Bake provider and authoring platform | Open engineering selection | Prototype; consult before mandatory external tooling or desktop-only authoring |
| Clustered default | Prototype with bounded fallback | A16/CEL/PBR benefit and parity |
| WebGPU migration | Separate experiment | Shader compatibility and measured gain |
| SSAO/SSR defaults | Optional until measured | Buffer cost and visual benefit |
| IBL shadows / volumetric lighting | Optional later experiments | Consult with real captures and incremental memory/frame cost before adding defaults |
| Full realtime point/large-world GI | Beyond selected native RSM support | Separate algorithm proposal if required; point-light baking remains in scope |

IBL shadows improve environment occlusion but do not replace diffuse bounce. Reflection captures render six views and need refresh budgets. Evaluate volumetrics against the actual installed backend/API, not feature-list assumptions. These experiments must not delay crash/loading repairs.

## Delivery tracker

| Milestone | State | PR / revision | Exact checks | Device evidence |
| --- | --- | --- | --- | --- |
| M0 Baseline | Planned | — | — | Required |
| M1 Lifecycle | Planned | — | — | Required |
| M2 Shadows | Planned | — | — | Required |
| M3 Controls | Planned | — | — | Touch |
| M4 Modes | Planned | — | — | Transitions |
| M5 Efficiency | Planned | — | — | Required |
| M6 Effects/materials | Planned | — | — | Required |
| M7 Baking | Planned; provider open | — | — | Runtime required |
| M8 GI | Planned | — | — | Required |
| M9 Qualification | Planned | — | — | Sustained gate |

Update this tracker in every milestone PR. Update affected render/material/asset/component documentation alongside behavior. Existing engine-plan statements about fixed capacities, rebuilds and light slots describe the older implementation; resolve conflicting passages when the replacing milestone lands. Full-pass completion requires features, tests, sustained device qualification and merged PRs. Missing device evidence stays an open gate.

## Primary references

Research used official documentation through Computer Use, web search and pinned source inspection. Recheck installed APIs at implementation time; the bundled Babylon 8 skill examples are not the 9.20 contract.

- [RSM GI manager 9.20](https://github.com/BabylonJS/Babylon.js/blob/9.20.0/packages/dev/core/src/Rendering/GlobalIllumination/giRSMManager.pure.ts) — native/custom material integration.
- [Clustered lighting](https://doc.babylonjs.com/features/featuresDeepDive/lights/clusteredLighting/) and [pinned container](https://github.com/BabylonJS/Babylon.js/blob/9.20.0/packages/dev/core/src/Lights/Clustered/clusteredLightContainer.pure.ts) — capabilities and supported light features.
- [HDR environment workflow](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/HDREnvironment/) — prefiltered environment assets.
- [PBR lightmaps](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/materials/using/masterPBR.md) and [pinned composition shader](https://github.com/BabylonJS/Babylon.js/blob/9.20.0/packages/dev/core/src/Shaders/ShadersInclude/pbrBlockFinalColorComposition.fx) — consumption and exact math.
- [Reflection probes](https://doc.babylonjs.com/features/featuresDeepDive/environment/reflectionProbes/), [default rendering pipeline](https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/defaultRenderingPipeline/), [SSR](https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/ssrRenderingPipeline/) — conventional features.
- [Shadow generator 9.20](https://github.com/BabylonJS/Babylon.js/blob/9.20.0/packages/dev/core/src/Lights/Shadows/shadowGenerator.ts) — allocation/filter behavior.
- [Performance budget](perf-budget.md), [render architecture](../architecture/render.md), [material graphs](../architecture/shader-graph.md), [asset containers](../architecture/containers.md), [testing](../architecture/testing.md) — repository integration contracts.
