# Shader Graph

Material, Material Function and Material Instance documents: the Babylon-free IR, validation, lowering and GLSL conversion, and how render compiles, previews and binds them.

## Decisions

- [`packages/shader-graph`](../../../packages/shader-graph/src/) owns the IR, catalog, validator, lowering and GLSL conversion and imports no Babylon or React. [`packages/render`](../../../packages/render/src/) maps a lowered plan onto real NodeMaterial blocks and owns every GPU resource. Material is the only shader editor.
- Values are `float`, `vec2`, `vec3`, `vec4`, `texture`. Colors are float vectors with a pin hint and booleans are floats, so the catalog stays inside Babylon's portable block set; the Babylon boundary picks `Color3/4` vs `Vector3/4`.
- Material Function calls are **inlined** at lowering under `callNodeId/innerNodeId` ids, because Babylon has no runtime function object. Each inlined operation maps back to its call node for diagnostics.
- Blocks Babylon lacks are composed from existing blocks (`fwidth` = derivatives + abs + add, `log2` = scaled ln, `inversesqrt` = reciprocal sqrt), never raw source.
- Fresnel (`shading.fresnel`) is a rim term like Unreal's and Unity's: `saturate(pow(saturate(Bias + 1 - |N·V|), Power))`, 0 facing the camera and 1 at the silhouette. Babylon's `FresnelBlock` is the inverse (1 facing), so render uses it only for `|N·V|` (bias 0, power 1) and composes the rest.
- The **Particle Texture** node is removed (emitters have no texture). Old graphs that contain `input.particleTexture` report `material.unknownNode` and do not compile; there is no migration.
- Not implemented: Decal domain, motion vectors, object IDs. Custom GLSL has no WebGPU path: a material closure containing it forces WebGL2 ([render.md](render.md)).

## Ownership

| Area | Source |
| --- | --- |
| Domains, catalog, node search aliases | [`catalog.ts`](../../../packages/shader-graph/src/catalog.ts) |
| Documents, defaults, `setMaterialDomain`, `materialDependencies` | [`document.ts`](../../../packages/shader-graph/src/document.ts) |
| Numeric conversion and generic width rules | [`types.ts`](../../../packages/shader-graph/src/types.ts), [`serialize-material.ts`](../../../packages/shader-graph/src/serialize-material.ts) (`materialPinsAreCompatible`) |
| Validation (`material.*` codes) | [`validate.ts`](../../../packages/shader-graph/src/validate.ts), [`custom-glsl.ts`](../../../packages/shader-graph/src/custom-glsl.ts) |
| Lowering, plan hash, compile key | [`lower.ts`](../../../packages/shader-graph/src/lower.ts) |
| Material Instances | [`material-instance.ts`](../../../packages/shader-graph/src/material-instance.ts) |
| Preview state machine and cost class | [`preview-state.ts`](../../../packages/shader-graph/src/preview-state.ts) |
| GLSL to Material | [`glsl-to-material.ts`](../../../packages/shader-graph/src/glsl-to-material.ts) |
| Block realisation, compile, blend/readiness | [`material-compiler.ts`](../../../packages/render/src/material-compiler.ts), [`material-block-registry.ts`](../../../packages/render/src/material-block-registry.ts) |
| Per-Scene cache, refcounts, parameters | [`material-library.ts`](../../../packages/render/src/material-library.ts) |
| Preview scene and gestures | [`material-preview.ts`](../../../packages/render/src/material-preview.ts) |
| Post-process stack | [`framegraph-post-process.ts`](../../../packages/render/src/framegraph-post-process.ts), `scene-post-process-*.ts` |
| Editor document state, Render button | [`material-editing-context.tsx`](../../../apps/editor/src/context/material-editing-context.tsx), [`material-editor.tsx`](../../../apps/editor/src/components/material-editor.tsx) |

## Documents

| Type | Kind | Suffix | Schema |
| --- | --- | --- | --- |
| `Material` | `material` | `.material.babasset` | `MaterialDocument` v3: `domain`, `shadingModel` (`pbr`/`unlit`), `blendMode` (`opaque`/`masked`/`translucent`/`additive`), `twoSided`, `defaultNormals` (`model`/`flat`), `alphaCutoff`, `preview`, graph |
| `MaterialFunction` | `material-function` | `.matfunc.babasset` | v2: typed `inputs` / `outputs` with **stable pin ids** (renames never break callers), graph |
| `MaterialInstance` | `material-instance` | `.matinst.babasset` | v1: `parentGuid`, cached `domain`, typed `overrides` by parameter name, `preview`; no graph |

- Domains: `surface`, `landscape`, `postProcess`, `particle`, `text`. Unknown strings parse as `surface`. Imported `Material` stubs open as `material`.
- `materialDependencies()` is the only source of `header.dependencies[]` (textures, called functions, inline Texture Sample guids, preview mesh) so references, delete guards and the export closure agree. Save also writes `domain` onto `header.payload`.
- Parameter names (`properties.name`) are nonblank, trimmed, case-sensitive and unique across Float/Color/Texture parameters; validation reports every unnamed or duplicate one and Save rejects them. Only root-Material parameters are runtime-settable; Material Function parameters stay internal defaults.
- Pin defaults persist as `default:<pinId>` on the node; lowering prefers the override, then the catalog default; pins with neither stay unset so the compiler can attach mesh or screen UV.
- `setMaterialDomain` drops nodes the new domain disallows. Surface and Landscape share the Material Output and keep it; other switches replace the terminal. Switching to Particle wires **Particle Color** into Color; leaving Text takes the new domain's shading/blend/two-sided defaults.

## Material Instances

- `resolveMaterialInstance` walks parents to the root Material (`MATERIAL_INSTANCE_MAX_DEPTH` = 16), nearest override wins. Missing parents, cycles and over-deep chains are errors, never silent fallbacks.
- `materializeMaterialInstance` yields a `MaterialDocument` keyed by the instance guid (root graph, parameter defaults replaced when the kind matches, runtime-only `instanceOf`). Every consumer uses these through the existing `Map<guid, MaterialDocument>` paths.
- `MaterialLibrary` compiles an instance under its root's name and then renames it, so all instances of a root share one compile and one GPU program; override edits are uniform/texture writes, never recompiles. Every Material picker also offers instances of the matching domain.

## Type rules

- Any numeric output connects to any numeric input. Conversion keeps leading channels, drops trailing ones and fills missing channels with **1** (Float `x` → V3 `(x,1,1)`); supplied zeros are preserved. Generic nodes take the widest connected input regardless of order. Declared function and Custom GLSL pins keep explicit types. The scripting graph keeps its stricter exact-kind rule.
- A scalar default on a wider pin fills every channel. Conversions compose across function boundaries and participate in the plan hash; render realises them with splitter/merger blocks and CPU baking applies the same rule.

## Validation and lowering

- Codes are `material.*`, each anchored to a node, pin or edge for Compiler Results. `material.postProcessCost` is a warning. `material.stageMismatch` fires when a fragment-only node (derivatives, `texture.sampleLod`, Normal Map, …) reaches World Position Offset, including through functions.
- Function validation visits each referenced function once (including disconnected calls); recursion and missing functions are errors.
- `lowerMaterialDocument` produces a deterministic `MaterialBuildPlan`: ordered operations, explicit conversions, texture bindings, `bufferRequirements` (`sceneColor`/`sceneDepth`/`sceneNormal`), cost features and a hash that **ignores node positions**. A call input is lowered only when the body reads it. Lowering is memoized per document, shading variant and functions-record identity, so replace function records, never mutate them.

## Compilation

- `compileMaterialPlan` instantiates real blocks and connects real ports. Babylon reports build failures through `onBuildErrorObservable`; the compiler turns them into diagnostics. `TextureBlock.autoConfigure` is not used (surface plumbing names UV `${name}_uv`).
- The compiler owns plumbing the graph does not author: Surface attributes, transforms and `PBRMetallicRoughnessBlock` unless unlit; Post Process fullscreen quad and screen UV (no WPO); Text Output multiplied by glyph coverage (only 2D Text / 2D Rich Text accept it); Particle mode (`NodeMaterialModes.Particle`, `particle_color` / `particle_uv`, and outside the editor preview a `ParticleBlendMultiplyBlock` before the output).
- World Position Offset is added in world space after the world transform; World Position nodes feeding WPO read the undisplaced vertex. Displacement does not inflate the AABB; use **Bounds Padding (Local)**.
- Sampled textures: acquire/`resolveMaterial` stay synchronous; the compiler binds the live Texture, builds, then rebuilds on `onLoadObservable` (unfreezing and refreezing a frozen material). `texture.isReady()` is not proof: Babylon's error sampler reports ready. A load error becomes `material.missingTexture`.
- `shareCompiledProgram` lets a Material-mode build without Custom GLSL adopt an earlier build's `buildId` on the same Engine when the compiled shader text is byte-identical.
- `MaterialLibrary` caches per Scene by asset guid + plan hash with refcounts. A new build replaces the old only after it builds, so a failed edit keeps the previous material on screen. `invalidate()` recompiles onto live GPU state after context restore.
- Custom GLSL (`custom.glsl`) is a typed function body (Babylon `CustomBlock`); derivatives or `discard` make it fragment-only. Readiness includes a hidden GPU probe: 15 s GLSL budget after the probe effect exists, a separate 120 s texture wait reporting `material.missingTexture`.
- Post-process buffers: Scene Color → `CurrentScreenBlock`, Scene Depth → `SceneDepthBlock` (`useNonLinearDepth = false`), Scene Normal → `PrePassTextureBlock`. A stack that cannot supply a buffer skips only that pass with an anchored `material.framegraph.buffer`.

## Preview

- The preview is a disposable Scene on the app-lifetime Engine, presented through `camera.outputRenderTarget` and a 2D blit. Never `registerView`, render the default framebuffer, or `camera.attachControl` (it binds the Scene/Play input element); gestures attach to the preview canvas only. Recreating the preview Scene bumps an epoch so the graph recompiles.
- `materialPreviewReducer`: `clean → dirty → queued → lowering → gpuCompiling → ready | error`, generation-safe; the last good image stays up while editing.
- `classifyMaterialCost` auto-compiles while measured compile time stays within two frames of the frame budget (`AUTO_COMPILE_FRAME_ALLOWANCE`); Custom GLSL and post-process graphs are always manual. Timings are session-local, never stored.
- **Render** (global toolbar, Material documents only) is disabled while compiling and for `MANUAL_RENDER_COOLDOWN_MS` (3 s) after a manual result. Position-only moves never recompile.
- Particle materials preview on one plane with a white Particle Color default and no Multiply block. RenderTargetTexture samples preview as opaque black.

## Runtime

- `MeshComponent.materialGuid` overrides the whole mesh; Model `materialSlots` apply by glTF `materials[]` index, then name. Play sends `assignMaterial`; editor viewports bind through `EditorSceneSync` instead.
- `SceneSettings.postProcessStack` (ordered Material guid + Enabled) compiles into the view's FrameGraph, skipping and reporting missing, non-post-process or failing entries rather than blacking out.
- Play and export close over surface and stack materials (including disabled entries), Material Functions and textures; the player hydrates documents, functions and the stack into `createEngine`. Preview Build packs PNG/pixels (`shouldPackKtx2ForPreviewBuild()` is false) so a cold iframe matches overlay Play; Export Game packs KTX2 when the transcoder ships.
- Default material, editor freeze and `postProcessingEnabled` rules: [render.md](render.md).

## GLSL to Material

- `convertGlslToMaterial(source, { name?, bindings? })` returns `{ ok, document, diagnostics }` or `{ ok: false, diagnostics }`; it validates and lowers but never saves or GPU-compiles. Output is an unlit translucent surface Material of ordinary nodes, no Custom GLSL.
- Subset: one `main`, float/vector locals, arithmetic, swizzles, numeric uniforms, explicit `uv`/`time` bindings and listed builtins. Control flow, helper functions, samplers, arrays, matrices, booleans, integer math and macros fail with a source-line diagnostic and no partial output. Limits: 32768 characters, 4096 tokens, 64 nesting, 2048 nodes.
- Exposed through the bundled GLSL to Material extension ([editor-extensions.md](editor-extensions.md)).
