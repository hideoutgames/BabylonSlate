# Lighting plan

The plan for Haptic's own data-driven lighting model: one lighting function that reads every light from one block and every local shadow from one atlas, used by every lit surface on WebGL2 and WebGPU. Decided; phases land as separate PRs. The engine is unreleased, so no phase carries migration or compatibility code: data in an old shape is dropped or regenerated. When the last phase lands, delete this file and move its decisions into [render.md](architecture/render.md) and [engine-plan.md](engine-plan.md).

## Why

Babylon bakes each light's type, shadow and filter into a receiver's defines (`LIGHT{i}`, `POINTLIGHT{i}`, `SHADOW{i}`, `SHADOWPCF{i}`), so a light switching, a shadow starting and a spawn are each a new program. On iPad WebKit a program costs seconds of link plus a blocking first draw, which a load either rehearses behind its loading screen (minutes) or leaves to gameplay (hitches). Two light paths and about fifteen render modules exist to manage when those compiles happen (legacy Forward and fixed-shape seats; the load rehearsal, admission predictions, light-neutral passes, hide-until-ready, first-draw budgets, WebGPU pipeline warm-ups). Lights as data remove the compiles, and with them most of that machinery.

## Invariants

- No light change compiles a shader: a light switching, spawning, moving, starting or stopping its shadows, or entering or leaving the light budget only writes data.
- A level's programs (its Materials with the mesh features they draw with, in each pass) are a bounded set, compiled behind its loading screen. Content arriving later (a streamed scene, a Class loaded on demand, a Material a script assigns that the level does not hold) compiles while it loads and stays hidden until ready (`reveal-pending.ts`), never compiling in the frame that first shows it. A settings change (quality level, render mode) may compile.
- One lighting path. No render-path setting; no light path chosen per material, per Scene or per device.
- Lighting enters a shader in exactly one place, the lighting function; everything about lights is uniform or buffer data.
- Every lit surface is a NodeMaterial built from a Material document. Engine code creates no lit `PBRMaterial`, `StandardMaterial` or `CelMaterial`. Built-in water is the one exception until Phase 5 (see Phase 3).

## Target design

### Light data

- One uniform block per Scene (`HapticLights`, std140 in GLSL, a uniform buffer in WGSL), rewritten when a light changes: counts per type (directional, point, spot, rect area), then fixed-size arrays of records up to a light maximum that the device profile (`device-profile.ts`) gains. A record holds position or direction, colour times intensity, range, cone, shadow record index and a valid flag.
- Each type loops to its runtime count, so each loop is branch-free. A light past the maximum is ranked out by the existing admission (priority, camera distance, incumbent bonus); slot kinds and slot classes go.
- One hemispheric fill, always declared, black when absent. Rect area lights stay unshadowed and read Babylon's LTC tables (`scene._ltcTextures`) as now, always bound, with the standard LTC Fresnel (as Babylon's OpenPBR material uses; Babylon's PBR block weighs its terms by the light's specular colour times intensity). Decided (Phase 5): prepared emission textures (1024², fixed) live in one always-bound 2D texture array, a layer per emission in use and a layer index in the light's record; a cap from the device profile, beyond which a light draws its flat colour with a diagnostic.
- Light falloff is physical for every surface (today Standard and CEL use range falloff, PBR physical). Specular, IES profiles, projection textures, lightmap modes and falloff types are not authored anywhere and are not supported.
- Decided (Phase 4): Babylon `Light` objects survive as inert data sources. Once no material and no shadow generator reads them they are inert; removing them (Haptic light records only, `scene.lights` empty and tested empty) means no future material can compile light defines. It depends on what in the editor and the shadow controller uses `Light` as an object (gizmos, picking, billboards, admission).

### Lighting function

- One function in GLSL and WGSL, behind one NodeMaterial block (`HapticLightingBlock`) that replaces `ScenePbrLightingBlock`, `CelLightBlock` and `SceneReflectionBlock` in `material-compiler.ts`. Inputs are the Material Output's: Base Color, Metallic, Roughness, Environment Influence, Normal, Emissive, Opacity, Alpha Clip (glTF occlusion arrives as Environment Influence, Phase 3).
- Direct light: metallic-roughness BRDF over the light loops, shadowed from the atlas. Environment: the Scene's environment cube with the spherical polynomial Haptic already overrides (`environment-irradiance.ts`), the environment BRDF table, `scene.iblIntensity`, and box-projected reflection probes swapped per mesh (`mesh-environment.ts`, `reflection-probes.ts`).
- CEL is a per-Scene define of the same function (hard steps for bands, shadow visibility and highlights, its own irradiance uniforms from `cel-shader.ts`). A render-mode change is a settings change and may compile.
- Decided (Phase 5): CEL shares PBR's graph. The function returns CEL's display colour converted to linear, so a CEL surface's emissive adds in linear, its fog mixes in linear with the linear fog colour, and the display conversion clamps it to one before Bloom, as PBR Legacy Display does; unfogged, non-emissive CEL is unchanged. A CEL highlight takes its light's colour times intensity (Babylon's took the white specular colour times intensity: the same for a colour whose largest channel is one).
- Babylon's NodeMaterial system keeps everything else: vertex paths (bones, morph targets, instances), fog, clip planes, the graph's own nodes.
- Not needed: clear coat, sheen, iridescence, subsurface, anisotropy, refraction. Neither Material documents nor the glTF loader (`gltf-loader.ts` registers no `KHR_materials_*` extension but unlit) can turn them on.

### Shadow atlas

- One depth-only texture per Scene, its edge from the device profile and the quality level. Sun cascades, spot tiles and a point light's six face tiles share it; each shadowed light's record holds its tile rects, matrices and bias. One sampling path: hardware compare for PCF, and for PCSS the same texture through a second sampler object without compare.
- Casters keep Babylon's depth-wrapper approach (bones, morph targets, instances, alpha test; authored World Position Offset through `AuthoredShadowDepthWrapper` and `authored-shadow-output.ts`; lattice through `NativeLatticeShadowDepthWrapper`) and render into viewport tiles of the one target. Caster depth variants are bounded by mesh features and compile at load.
- Admission keeps its ranking (`planShadowAdmission`: priority, `SHADOW_MIN_RESIDENCY_MS`, distance with the incumbent bonus, the sun first) and allocates tiles instead of maps; the budget is atlas area.
- Full Quality captures lease cascade tiles from the same atlas and fall back to the scene's cascades when it is full, as captures fall back today.
- Must preserve: neutral until drawn (the record's valid flag); automatic directional bias, per-caster normal bias, receiver-plane PCF and cascade fade (`shadow-receiver.ts`, `shadow-shader.ts`); PCF and PCSS at three quality levels (CEL turns PCSS into PCF); range-fitted local depth; spatial and submesh caster culling (`shadow-geometry-partitions.ts`, `shadow-mesh-policy.ts`); render-once refresh per tile on caster revision, cascades on camera change, continuous refresh for unsafe casters (`shadow-map-refresh.ts`); ranking, residency and priority; the mobile cap; the diagnostics rows (`shadow-diagnostics.ts`, `renderDiagnostics().shadowMapBytes`); volumetric sampling; the authored and lattice depth uniforms; the WebGPU warm and isolated caster draws (`shadow-map-warm.ts`, `shadow-caster-warm.ts`), re-keyed for one render target, until the CI gate proves them unneeded; the Babylon patch hunks the depth wrappers rely on.
- Dropped: standby maps, parking, donor `moveTo` and receiver exchange; slot-define tracking (`shadow-slot-defines.ts`), per-filter seat samplers, `admissionSamplers`, sampler placeholders (`shadow-sampler-placeholders.ts`) and the sampler headroom (`light-sampler-budget.ts`); cube maps and the Poisson fallback (six compare tiles make point lights PCF); the colour attachment; the CSM four-layer peak charge; the 64 px prediction maps; transparency shadows, frustum edge falloff, darkness as a setting and the cascade debug define, none of which is used.

### Other readers of lights

- Volumetrics read the light block and the atlas instead of their own slots (`volumetric-lights.ts`).
- Water's CPU lighting (`water-scene-state.ts`: strongest directional plus hemispheric) reads the light records; built-in water becomes a graph Material on the block (see Phase 5).
- Geometry passes no longer carry light defines, so `light-neutral-tasks.ts` goes.
- Previews and thumbnails use the same path. Their studio lighting (two `HemisphericLight`s, `preview-lighting.ts`) becomes a directional key and the hemispheric fill: a deliberate look change, and thumbnails regenerate.
- The editor world view draws through the same path; Unlit viewport mode is a define of the function.

### CI gate

- A test plays scripted gameplay after a Play load (lights switched, spawned and moved, shadows started and stopped, a light pushed past the budget, spawns of Classes the level holds) and asserts the Engine's compiled-Effect count and WebGPU pipeline misses do not change after the first presented frame, on WebGL2 and WebGPU. The compile-hold acceptance harness (`compile-hold-acceptance.test.ts`) and the variant-swap proof routes already measure both.
- It cannot pass on the legacy path. It enters with Phase 5 as a test of the new path behind its switch, and becomes a merge gate when Phase 7 makes the new path the default.

## Phases

Each phase is one PR, or a short series, merged into `main` before the next starts.

3. **Material consolidation on the current lighting**, with no visible change. Done:
   - Preserved glTF slots become Material documents (importer only). Done: occlusion as Environment Influence (glTF occlusion is indirect-only), identity `KHR_texture_transform`, image-less textures and unread extensions, NEAREST samplers as a Texture Sample's Filter with the Pixel Art usage, UV set 1 (the UV node's UV Channel) and `KHR_texture_transform` (Transform UV's Tiling, Rotation and Offset, the rotation negated as Babylon's loader turned it); every bundled model converts. Only a texture on UV set 2 or later still leaves a slot empty.
   - Decided: a file's own materials are never drawn. Models load with `skipMaterials`; a slot draws its Material asset, an empty or unresolved slot the engine default checker, in scenes, Play, previews and thumbnails alike.
   - Built-in water stays a `PBRMaterial` with its plugin. A Custom Material on the water blocks lacks planar reflections, the edge fades, haze, the refraction fallback, specular shaping and the IOR, the Low tier's unlit path, the CEL exemption and two-sided drawing; about half of that is PBR shader internals no graph reaches. Decided (Phase 5): it becomes a graph Material on `HapticLightingBlock`; the water blocks gain what the plugin has (Phase 5).
   - `CelMaterial` and the native CEL swap (`scene-render-mode.ts`) go; CEL stays on graph Materials only. Done, with the CEL **Reflection Textures** setting, which only `CelMaterial` read.
   - After this phase `ScenePbrLightingBlock`, `CelLightBlock` and built-in water are the only places lighting enters.
4. **Spike**: a `HapticLightingBlock` lighting unshadowed lights from the block, in GLSL and WGSL. It answers:
   - IBL and specular parity against `ScenePbrLightingBlock`, by screenshot comparison;
   - the per-pixel cost of the loops on the A16 iPad at the Feature Test's light count, as a Benchmark profile against Forward;
   - the Light-object decision;
   - PCSS through a second sampler object on WebGL2 and WGSL.

   Spike PR 1 (merged, superseded): light loops injected into Babylon's PBR block, which matched its pixels on WebGL2. Decided after it: the function is Haptic's own (`HapticLightingBlock`, as above, rather than Babylon's PBR block with Haptic lights), and Babylon `Light` objects stay as inert data sources (gizmos, picking, admission and the shadow controller read them; no Material does, and the CI gate asserts no compiled Effect carries `LIGHT0`). The A16 cost measurement is not a gate: the iPad lost its WebGL context at about 490 programs during the Feature Test's main Play load, most of them the load rehearsal's light variants, which this model removes.

   Phase 5 PR 1: `HapticLightingBlock` (GLSL), behind the switch: direct light from the `HapticLights` block and environment light (the Scene's cube, its pre-scaled irradiance harmonics, rotation, box projection, the BRDF table). `e2e/haptic-lights.spec.ts` draws three surfaces in six poses (lights, environment only, a rotated cube, a box-projected cube) within 1/255 of Babylon's PBR block, and light changes compile nothing.

   Phase 5 PR 2: CEL as the block's `HAPTIC_CEL` define. The same spec draws nine CEL poses (sun, fill, environment, a rotated cube, the three mixing modes, highlights) pixel-identical to Babylon's `CelLightBlock`; point and spot lights differ by the physical-falloff decision.

   Phase 5 PR 3: the WGSL twin, so the switch applies on WebGPU. The spec runs on WebGL2 and WebGPU; on WebGPU Babylon's reflection block cannot compile a box-projected cube (its WGSL reads the box uniforms without the `uniforms.` prefix), so graph Materials lit by a box-projected reflection probe fail to compile there until the new path is the default.

   Phase 5 PR 4: rect area lights in the block (records of centre and half extents, the LTC tables always bound), PBR and CEL, GLSL and WGSL. A white metal under a rect light of intensity one matches Babylon's PBR block exactly (the one case where the two Fresnels agree). Babylon's light block, which CEL graphs use today, draws rect lights far dimmer than its PBR block does, so CEL rect lights have no reference.

   Phase 5 PR 5: emission textures as layers of one texture array (`area-emission-array.ts`; the cap is `DeviceProfile.areaEmissionLayers`, 4 on desktop, 2 on mobile), and the rect light owner keeps no texture per light on this path. The white metal under an emissive rect light matches Babylon's per-light emission texture exactly.

   Built-in water as a graph Material, as a series. Decided: the Material Output gains **Specular** (0 to 1, default 0.5, a non-metal's F0 = 0.08 × Specular, Unreal's and Godot's convention; water 0.255), which Babylon's PBR block takes as a constant index of refraction (lowering warns of one that is not constant, until Phase 7); water follows CEL like every other surface (no opt-out); water is always lit (the Low tier's unlit drawing goes; a custom water Material can be Unlit). The water blocks gain what only the plugin has (removal volumes and land above the water, the depth pre-pass and colour pass discards, planar reflections, the refraction fallback at silhouettes, haze and the horizon flattening, the edge and open-water fades, the horizon lift and half-vector normal, the four-tap shoreline, slope-variance roughness, the premultiplied coverage solve and fog pre-division, the vertex blend cull, the geometry-pass exemption, two-sided drawing); built-in water's template becomes a Material document of those blocks, compared with the plugin's pixels; then the plugin and the code keyed to it go (`isBuiltInWaterMesh`, `getPlugin("SlateWater")`, `WaterReflection`'s `PBRMaterial`). The plugin's dead sun glitter terms are not ported.

   Phase 5 water PR 2: the Water Cut block (`WaterCutBlock`), which the compiler adds to every Surface Material: removal volumes and land above the water, a blending neighbour's water, the depth pre-pass discard and early return, the colour pass's discard after every derivative, and the vertex blend cull on the GPU path. Decided: every Material a water mesh draws is cut, so every water mesh keeps its terrain and contact fields.

   Phase 5 water PR 3: planar reflections on the Water Reflection node, through the plugin's lookup (`planarLookupSource`); the mirror's owner takes any water that mirrors objects (`waterMeshReflectsObjects`), and frozen Custom Materials re-prepare their water defines on a Water quality change or a tilt. Decided for the next PR: haze reaches the lighting through a **Normal** output on Water Reflection (the starter wires it to the Material Output's Normal), and the edge and open-water fades through an **Edge Fade** output on Water Depth Fade (the starter multiplies Opacity by it); the refraction fallback matches built-in water exactly; the four-tap shoreline stays with its own PR.

   Phase 5 water PR 4: Water Scene Color refracts as built-in water does (its bend scale, the tilt's sign, the silhouette fallback `silhouetteFallbackSource`, a soft Available), Water Depth Fade gains **Edge Fade** (built-in water's bank, edge and open-water fades, `waterEdgeSource`, which also gives every water node built-in water's depth), and the starter multiplies Opacity by it. Gentle shores fade over 6 cm until the four-tap shoreline lands. Haze and the Normal output follow.

   If the loops cost too much on the A16, add light culling (per-cluster light lists built on the CPU) before Phase 5. Clusters, not per-mesh lists, because per-mesh lists fail on large surfaces and instanced batches.
5. **Light data path behind an Engine switch**: light records, the block, ranking to the profile maximum, rect area lights, the fill, CEL as the per-Scene define, volumetrics and water reading the records, previews moved over. The CI gate runs on this path.
6. **Shadow atlas** behind the same switch, with the preserve list above.
7. **Default**: the CI gate passes on the new path; it becomes the default and a merge gate; the Feature Test is measured on the A16 iPad and an iPhone. The user docs take the look changes it ships (physical falloff, previews, CEL's fog and emissive), and Specular's constant-only warning goes.
8. **Deletions**: legacy Forward's per-light path (`forward-light-budget.ts` slot kinds, `forward-light-slots.ts`); fixed-shape lighting (`fixed-light-*.ts`, core `fixed-light-layout.ts`, the `fixedlights` command and its Benchmark profiles); `variant-prediction.ts` and the prediction maps; the load rehearsal's light steps and its mobile limits; `light-neutral-tasks.ts`; `reserveSceneLightInventory`; the shadow controller's standby, parking, donor and exchange, slot defines and sampler placeholders; `light-sampler-budget.ts`; the `_materialLightHooks` hunks of the Babylon patch; `ScenePbrLightingBlock`, `CelLightBlock` and `SceneReflectionBlock`; the CEL graph swap (`cel-surface.ts`, `display-color-block.ts`) and `cel-shader.ts`'s patches of Babylon's light functions; the Poisson fallback report.
9. **Later, decided separately**: fewer material variants (texture presence and similar defines as always-bound defaults), measured on its own.

## Risks

- Per-pixel loop cost on the A16 at the Feature Test's light count (Phase 4 measures it; culling is the remedy).
- Environment and specular parity with Babylon's PBR, which existing Scenes are lit by.
- WGSL parity of the function, the block and the atlas sampling.
- Atlas tile bleeding under PCF and PCSS kernels, and seams between a point light's six tiles.
- Authored World Position Offset in the atlas depth pass.
- WebGPU shadow-pass pipelines created synchronously, until the CI gate proves the warm-ups unneeded.
- NodeMaterial block API changes at the next Babylon upgrade (pinned; an upgrade re-checks the block).
- An unexplained `RangeError: Maximum call stack size exceeded` in the Feature Test's main Play load on the A16 iPad, around the WebGL context loss there; no stack yet. The Feature Test Check now records page errors and samples, so a later run on the new path can show whether it remains.
