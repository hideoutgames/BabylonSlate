# Materials and Material Functions

Material headers distinguish outputs (red), constants (green), parameters and
inputs (teal), textures (amber), functions (blue), custom code (brown), and
math/vector operations (muted). Palette markers use the same roles.

**VectorMask** selects R/G/B/A in Details (R by default). At least one channel
must remain selected. The output is Float, V2, V3, or V4/Color according to the
selected count, in RGBA order; the title displays the selection. Vector inputs
must contain every selected channel: a V2 cannot supply B or A. A disconnected
input defaults to a zero V4 and remains connectable to any vector width.

One authored asset type covers what used to be split between an empty imported
`Material` stub and an authored `Shader` graph. A **Material** is a node graph
with a `domain`, and a **Material Function** is a reusable typed subgraph.

`@babylonslate/shader-graph` owns the IR, validator and lowering and stays
Babylon-free. `@babylonslate/render` maps a lowered plan onto real Babylon
NodeMaterial blocks and owns every GPU resource.

## Documents

| Asset type | Document kind | New-asset file name |
| --- | --- | --- |
| `Material` | `material` | `.material.babasset` |
| `MaterialFunction` | `material-function` | `.matfunc.babasset` |

`documentKindForAssetType` also opens legacy `Shader` / `ShaderGraph` headers
and imported `Material` stubs as `material`. Saving rewrites the header to
`Material` through the existing migrate-on-save approval. Paths are **not**
renamed, so `.shader.babasset` files keep working and their layout ids,
references and Git LFS locks stay valid.

`MaterialDocument` (v3) carries `domain` (`surface` | `postProcess` | `particle`),
`shadingModel`, `blendMode`, `twoSided`, `alphaCutoff`, `preview` and the graph.
Unknown domain strings, including leftover HUD `interface`, parse as `surface`.
There is no `output.interface` node and no WidgetComponent / HUD Material blit
path.
`MaterialFunctionDocument` (v2) carries typed `inputs` / `outputs` with **stable
pin ids** plus the graph; renaming a pin does not break callers.

`materialDependencies()` is the authoritative source for `header.dependencies[]`
— textures, called functions and the preview mesh — so Show References, delete
guards and the export closure all see them.

## Type system

Values are `float`, `vec2`, `vec3`, `vec4` and `texture`. Colors are float
vectors with a pin hint, not a separate type; the Babylon boundary picks
`Color3` / `Color4` versus `Vector3` / `Vector4`. Booleans are floats so the
catalog stays inside the portable block set.

A `float` splats into any vector. Everything else must match exactly:
truncation and partial widening need an explicit **Split** or **Combine** node
so the graph says which components move where. Generic nodes (`math.add`,
`math.mix`, …) resolve their group from the types actually wired in, so a vector
width propagates down a chain instead of collapsing at the first hop.

`materialPinsAreCompatible` gives the canvas the same rule through the
`pinCompatibility` prop on `GraphEditor`; the scripting graph keeps its stricter
exact-kind default.

**Color Parameter** defaults to RGBA (`vec4`) and provides an explicit **RGB**
(`vec3`) output for Base Color and other three-component inputs. Older material
and function documents gain alpha `1`, and their existing Color Parameter Out
links move to RGB so their appearance and downstream vector widths stay intact.

## Parameter authoring

Adding or pasting a Float, Color, or Texture Parameter opens **Name Material
Parameter**. Enter a nonblank name unique across all parameter types in that
graph; names are trimmed and case-sensitive. Cancel removes the unnamed node and
its links. Pasting keeps the default value but requires a new name. The node
title shows its name, and Details exposes **Parameter Name** and its default:
Float value, RGBA vector plus color picker, or Texture asset.

Names are stored in `properties.name`; numeric defaults use `properties.value`
and Texture defaults use `properties.textureGuid`. Validation reports every
unnamed or duplicate parameter, including unconnected nodes. Save rejects these
name errors before writing the asset.

The naming dialog tracks newly added or pasted nodes only. Invalid names in an
existing or loaded graph remain editable in Details; cancelling a naming dialog
cannot remove those nodes or their links.
Schema upgrades give legacy unnamed or duplicate parameters deterministic unique
names while preserving existing authored names, so older materials keep rendering.

Runtime parameter setters expose parameters on the root Material graph. Material
Function parameters remain internal defaults; expose function inputs to pass
values from the calling material.

Material graphs use the shared 96px pin safe zone: releasing a wire near a pin
after leaving its source handle breaks that source pin's links. Releasing on the
source handle preserves its links; releasing on distant empty canvas opens Add
Node. Hit tests stay inside the current canvas, including when multiple docked
or warm Material tabs reuse node IDs. Live hints use the Material Float-to-vector
connection rule.

## Validation

`validateMaterialDocument` / `validateMaterialFunctionDocument` report node, pin,
type, cardinality, cycle, domain, stage, capability, missing-asset and function
errors. Codes are `material.*`, each anchored to a node, pin or edge so the
Compiler Results panel can focus the offender. `material.postProcessCost` is a
warning, not a blocker. `material.stageMismatch` is raised when a fragment-only
node (derivatives, `texture.sampleLod`, Normal Map, …) reaches **World Position
Offset**, including through a Material Function (`call/inner` node ids).

## Lowering and compilation

`lowerMaterialDocument` produces a deterministic `MaterialBuildPlan`:
topologically ordered operations, explicit operands (including inserted splats),
texture bindings, dependencies, cost features and a content hash that ignores
node positions. Material Function calls are **inlined** here under namespaced
operation ids (`callNodeId/innerNodeId`) because Babylon has no runtime function
object; each inlined operation still maps back to its call node.

`compileMaterialPlan` instantiates one or more real Babylon blocks per operation
and connects actual connection points. Texture Sample / `param.texture` bind
through `resolveTexture` (ResourceCache). Overlay Play usually sees a ready PNG
from Editor Texture LOD. Preview Build packs **PNG/pixels** (`shouldPackKtx2ForPreviewBuild`
is always false) into a cold iframe Engine so it matches overlay Play. Itch
**Export Game** still packs KTX2 when the transcoder exists. `bindTexture` may
still run while a packed texture is not sample-ready (`loadingError`, error /
empty InternalTexture, or `!isReady()`). `acquire` / `resolveMaterial` stay
**synchronous** (slot bind cannot wait): the
compiler assigns the live `Texture` object, calls `material.build()`, then
subscribes `onLoadObservable` and **rebuilds** so the mesh does not stay on
Babylon’s error sampler. `texture.isReady()` is not enough — Babylon’s error
sampler reports ready. Frozen NodeMaterials ignore dirty/`build()`: the load
callback **unfreezes**, rebuilds, re-applies authored blend
(`applyAuthoredSurfaceBlend`), **marks the material dirty with
`blockMaterialDirtyMechanism` off**, then restores freeze if the material was frozen.
`prewarmMaterial` / player `whenMaterialTexturesReady` skip
`forceCompilationAsync` until TextureBlocks are sample-ready so Intermediate
`checkReadyOnlyOnce` cannot bake the sampler. `onErrorObservable` (when the Texture exposes it) reports
`material.missingTexture` instead of leaving the error sampler forever; rebuild
errors surface the same way rather than swallowing. `createEngine({ playMode: true })`
skips `applyEditorMaterialFreeze` so Play / the packed player never
**additionally** freeze library materials after compile / prewarm. Play scenes
still use `ScenePerformancePriority.Intermediate`, which sets
`checkReadyOnlyOnce` (`isFrozen`) when a NodeMaterial first becomes ready.
Editor freeze stays, but the load callback still unfreeze-rebuild-refreezes.
The packed player also sets
`KhronosTextureContainer2.DefaultNumWorkers = 0` (decode on this thread; blob
Workers often fail to `importScripts` the self-hosted wasm under COEP) and
`DefaultDecoderOptions.forceRGBA` for that play-mode Engine (software WebGL
often advertises ASTC then fails `texImage2D`; editor/overlay still use PNG
LOD). After
`material.build()`, authored
`blendMode` / `twoSided` / `alphaCutoff` are applied (`MATERIAL_OPAQUE` for
opaque including unlit, alphatest + cutoff for masked, alphablend +
`needDepthPrePass` for translucent/additive, `backFaceCulling = false` when
two-sided). The compiler owns plumbing the graph does
not author:

- **Surface**: position/normal/uv attributes, world and clip-space transforms,
  view direction, and a `PBRMetallicRoughnessBlock` unless the material is unlit.
  **Emissive** (`vec3`, default black) adds self-illumination at each shaded
  surface point, including curved meshes and texture masks. Connect a Texture
  Sample's RGB output, optionally multiplied by a color or strength, to Emissive.
  Black contributes nothing; values above one support bright emission. PBR adds
  emission to linear lighting before display image processing. Other surface
  channels still respond to lights. Unlit keeps its existing direct Base Color
  output and adds Emissive to it. Emission does not create lights, illuminate
  nearby objects, or automatically add bloom/glow. Existing materials with no
  authored emission retain their previous rendering path.
  **World Position Offset** (`vec3`, default `[0, 0, 0]`) is added in world
  space after the world transform. A constant-zero channel is skipped. The
  compiler realizes that subgraph first so **World Position** nodes that feed
  WPO read the undisplaced vertex; fragment-only World Position nodes compile
  afterwards and see the displaced position. One World Position node wired into
  both keeps the pre-offset value — duplicate the node if you need both. Clip
  and PBR lighting use the displaced position. Displacement does not inflate
  the mesh AABB, so large waves can cull early; authors recompute normals on
  the **Normal** channel when they need them.
- **Post process**: the `position2d` fullscreen quad, its vertex output, and the
  screen UV remapped from clip space. Babylon still requires a vertex output in
  post-process mode. There is no World Position Offset channel.
- **Particle**: `NodeMaterialModes.Particle` so `createEffectForParticles` can
  attach. Vertex program may be empty; the terminal is fragment color/alpha
  only. **Particle Color** (`input.particleColor`) is the system's
  `particle_color` attribute (Babylon 9 has no `ParticleColorBlock` class).
  **Particle Texture** (`input.particleTexture`) is `ParticleTextureBlock`;
  unwired UV uses `particle_uv`. Live sampling is always
  `system.particleTexture` — an NME preview texture is ignored. Hide world
  attributes, WPO, PBR, Normal Map, and post-process buffers.

Babylon reports build failures through `onBuildErrorObservable` rather than
throwing, so the compiler subscribes and turns them into diagnostics. Blocks
Babylon lacks are composed from existing ones rather than raw source — `fwidth`
is derivatives plus absolute values plus an add, `log2` is a scaled natural log,
`inversesqrt` is a reciprocal square root.

Compiled graph assembly exposes `ready`, which settles after Babylon finishes
loading block shader code and building the graph. Preview awaits this result;
the library retains the previous generation until a replacement succeeds.
Deferred failures retain diagnostics instead of publishing a broken replacement.
Function validation follows nested calls in the caller's domain and capabilities,
with call-path diagnostics. Recursive calls never enter the WPO stage walker.

Surface opacity reaches fragment alpha. Masked surfaces discard pixels whose
**Alpha Clip** value is below **Alpha Cutoff**; an unwired Alpha Clip uses
Opacity. Additive uses additive blending. PBR surfaces include the Scene's
environment reflection and irradiance, including when emission is connected.
Clamp supports connected scalar/vector bounds; comparisons return component-wise
numeric masks. Refract uses Vector 3 directions and scalar Eta. Split connections
to components absent from the input vector produce diagnostics. World Tangent
is transformed as a direction by the mesh world matrix.

`MaterialLibrary` caches per Scene keyed by asset guid plus plan hash and
refcounts instances. A Babylon material belongs to one Scene, so the editor
viewport, a preview tab and a Play session each hold their own. A new material
replaces the old one only after it builds, so a failed edit leaves the previous
material on screen. `acquire` rebuilds when the cached `NodeMaterial` is
already disposed (removed from `scene.materials` — NodeMaterial has no
`isDisposed()`). `invalidate()` drops every cached instance so the next acquire
compiles onto live GPU state. WebGL restore also calls `releaseGpuTextures()`
so Texture Parameters bind new InternalTextures instead of a white cube.

## Preview and the Render button

The preview is a disposable Scene on the **app-lifetime Engine** — never a
second WebGL context. `createMaterialPreviewScene` builds cube, sphere,
cylinder, cone, plane, or a custom Model, and applies either the material or a
camera post-process. Present goes through `camera.outputRenderTarget` (an RTT)
and a 2D blit onto `material-preview-canvas`. Do **not** `registerView` or
default-framebuffer `scene.render()` — those overwrite the Scene viewport and
Play overlay, which share that Engine. Prefab Preview is on that Engine too
(`p18-shared-prefab-engine`) via RTT + 2D blit. Orbit / pinch / wheel attach to the preview canvas
only (`attachMaterialPreviewGestures`); never `camera.attachControl`, which
Babylon binds to the Engine input element (Scene / Play). Vertical orbit matches
the Scene viewport (`beta -= dy`; dragging down looks up). Hidden Material tabs
and in-editor Play freeze present. Recreating the preview Scene (canvas remount,
tab remount after idle-unmount, WebGL context restore) bumps a scene epoch so
the graph recompiles onto the new Scene even when the compile key is unchanged.
`ResourceCache.getTexture` / `getMaterialTexture` also replace a cached Texture
whose GPU object is gone (Babylon Texture has no `isDisposed()`; scene-owned
wrappers lose `getScene()`, engine-owned ones lose `_engine`) — otherwise
Render would bind a dead GPU object and the preview would stay a white cube
until the Material tab closed.

The compact `material-preview-overlay` contains only the viewport-style mesh
`ToggleGroup`. Preview icons resolve at render time so lazy production chunk initialization cannot leave stale, undefined icon entries. Cube is the document default and the runtime fallback for
missing/invalid custom bytes. **Custom** opens the existing Model `AssetPicker`
directly; selecting None or dismissing an initial pick returns to Cube. A
picked custom Model can be re-picked from the same Custom icon. There is no
separate Pick Mesh button or visible Ready/status badge (the canvas keeps its
machine-state data attributes for tests).

**Render** lives in the global editor toolbar beside the Class graph Compile
slot and appears only for the active Material document (not Material
Functions). It can manually refresh a material that is already ready. It is
disabled while queued/lowering/GPU compiling and for three seconds after a
manual result (success or failure); automatic cheap-graph compiles do not start
that cooldown.

The default Material dock stacks **Preview** over **Details** on the left
(~25% width, 50/50 height) so **Graph** keeps about 75% width. Compiler Results
still sit under the graph. Persisted `layout.json` is unchanged until reset.

`materialPreviewReducer` is generation safe:

```
clean → dirty → queued → lowering → gpuCompiling → ready | error
```

Every edit bumps the generation. Cheap graphs auto-queue after a trailing
debounce; expensive ones stay dirty until **Render**. A manual Render of the
ready generation queues a fresh render generation. A result from an older
generation still becomes the last good image unless a newer compile is already
in flight, so the preview is never blank while editing.

`classifyMaterialCost` prefers measured compile durations once the session has
two of them and compares them against the **active frame budget**
(`1000 / playFrameCap`), not a fixed millisecond constant. Custom GLSL and
post-process passes are always manual because neither is profiled on the device.
Timings stay session-local and are never written into an asset.

Layout-only node moves do not recompile: `materialCompileKey` / the plan hash
ignore positions. The graph canvas commits positions once per drag, with a
per-gesture `transactionId` so Undo restores one drag at a time. Measured-size
frames and identical payloads do not dirty the document. The preview canvas
exposes `data-camera-radius` (and test-mode `materialPreviewCameraRadius`) so
e2e can dispatch wheel and two-pointer pinch on the preview canvas. Gestures
attach only to that canvas (`attachMaterialPreviewGestures`); never
`camera.attachControl`, which Babylon binds to the Engine input element.

## Pin defaults and Details

Unconnected numeric and color inputs show the same read-only canvas widgets as
the Class graph (`PinDefaultPreviewWidget`). Typed Object / Asset / Class /
Struct / Enum inputs on that shared `PinNode` chrome show constraint type names
rather than stored values. Catalog `defaultValue` (and
`colorHint` swatches) hydrate onto `__pins`; authored overrides persist as
`default:<pinId>` number arrays on the node. Widgets hide when that pin is
wired. Lowering prefers the authored override, then the catalog default;
unwired pins with neither stay unset in the plan (Normal, Alpha Clip, Texture
Sample UV/texture, Scene Color/Depth/Normal UV). The compiler then attaches
mesh UV or screen UV when a sample's UV pin is absent. World Position Offset
defaults to `[0, 0, 0]` when unwired.

Details is selection-aware:

- **No node selected:** Domain (Surface / Post Process / Particle), Shading Model, Blend Mode, Two Sided (and Alpha
  Cutoff when masked) plus the cost line.
- **A node selected:** those material settings hide; the panel shows only that
  node's properties and unconnected pin-default editors.

## Custom GLSL

`custom.glsl` uses a typed function body on new nodes. Define named numeric
inputs and additional outputs in Details, return the primary output, and assign
additional outputs by name. The expanded editor provides GLSL highlighting and
line numbers; the node shows four read-only code lines. Existing expression
nodes retain `result = fn(a, b)` until explicitly converted.

The validator checks interfaces, function boundaries, stage restrictions and
GLSL/WebGL capability. GPU errors appear as `material.compile.glsl`, with body
line mapping when available. Babylon `CustomBlock` generates the function
signature. Body and interface edits participate in the plan hash. Custom nodes
use manual **Render** and retain the last good material on compilation failure.

## Inline Texture Sample

`texture.sample` and `texture.sampleLod` may store `textureGuid` on the node
while still accepting a wired `param.texture`. An unwired texture input is
valid only when that asset is set. The GUID is part of
`materialDependencies()`, header `dependencies[]`, and the Play/export
closure. Selected Texture Sample and Texture Parameter nodes expose an
`AssetPicker` in Details.

Unwired UV does **not** lower to a constant `[0, 0]` (that used to sample one
texel and look like a solid color). Lowering omits the pin so the compiler
can connect mesh UV (`plumbing.uv`) on a surface material or screen UV
(`plumbing.screenUv`) on a post-process. An authored UV / Transform UV edge
still wins. Babylon `TextureBlock.autoConfigure` is not used: it looks for a
block named `"uv"`, while surface plumbing names the attribute `${name}_uv`.

Material preview resolves Texture chunks the same way Play does: preload
`pixels` then `source` via `readAssetChunk` into the Engine
`resourceCacheForEngine` cache, and pass `resolveTexture` into
`MaterialLibrary`. A guid that cannot load
surfaces as `material.missingTexture` instead of a sampler-less black
preview. Editor validation also receives `textureExists` from the asset
registry so Compiler Results can flag a missing Texture before GPU compile.

Playwright wires Sample `rgb` → Output `baseColor` without a UV node (and a
second path Parameter `out` → Sample `texture`) and asserts
`material-preview-canvas` `data-status="ready"`.

## Post-process buffers

`MaterialBuildPlan.bufferRequirements` records `sceneColor`, `sceneDepth` and
`sceneNormal`. Those nodes are post-process / fragment only.

| Node | Babylon realisation |
| --- | --- |
| Scene Color | `CurrentScreenBlock` |
| Scene Depth | `SceneDepthBlock` with linearized depth (`useNonLinearDepth = false`) |
| Scene Normal | `PrePassTextureBlock.worldNormal` sampled through a `TextureBlock` |

If a device cannot provide a required buffer, `attachPostProcessStack` skips
**only that pass** and reports an anchored `material.capability` diagnostic on
the Scene Depth / Scene Normal node. Runtime probes depth with a try/catch
`enableDepthRenderer` and pre-pass support without disposing a renderer another
subsystem already owns. Compilation runs first; only successful passes lease a
linearized camera depth renderer (`useNonLinearDepth = false`,
`storeCameraSpaceZ = false`) or a shared pre-pass renderer. The stack releases
only buffers it created.

## Runtime

`MeshComponent.materialGuid` binds a Material (whole-mesh override). Imported models also carry ordered `materialSlots`; Play and the editor viewport apply those after `LoadAssetContainerAsync` (`applyModelMaterialSlots`). Slot index is the glTF `materials[]` index (loader `/materials/N` pointer), then construction name — not child visit order. Empty/Default guid restores the glTF construction material. A primitive (or any mesh that still has `material === null` after that) draws with the engine default: a lit `PBRMaterial` UV checker (`metallic` 0, `roughness` 0.5, grey / slightly darker grey) installed as `scene.defaultMaterial` — not Babylon’s white `StandardMaterial`. Inspector **None** stays `materialGuid: null`; the checker is not a Content Browser asset. Play emits `assignMaterial`, optionally with a
`componentId` (slot ids / `actor-<slot>` names). The renderer applies a
whole-actor assignment across a multipart actor's descendants and a component
assignment to one named mesh, re-applies after a mesh rebuild, and releases
records on despawn. Editor viewports (scene and Prefab) do **not** use that
Play path: `EditorSceneSync` binds the same guid onto `editorActor:<id>` /
`editorActor:<id>|<componentId>` through `MaterialLibrary.resolveMaterial`.
The shared browser fixture asserts the authored material on Scene, Prefab,
overlay Play, Preview Build, and the packed player rather than relying only on
command-record tests.

### Viewport / Play / Preview pixels

| Look | Meaning |
| --- | --- |
| Red/magenta checker | Babylon **error sampler**: Texture assigned but not sample-ready, decode failed (`loadingError`), or a rebuild that never dirtied meshes. Preview Build packs PNG so CI SwiftShader is not a false green vs hardware KTX2. |
| Solid red | GLB **slim stub** (`slimGlbEmbeddedImages` 1×1 red PNG) when slot materials never stick. Slim now also requires those Materials compiled (`compiledMaterialGuids`). |
| Grey UV checker | Engine default when `materialGuid` is empty and there is no glTF construction material. |
| Black | Failed compile, missing/broken IBL on PBR, boot/iframe failure, or a freeze that never rebuilt. |

Pack warns when a Material samples a Texture guid with no bytes (`Packed Material samples Texture … with no bytes`). Logic `compileGraph` cannot paint an error sampler.

Scene Details authors `SceneSettings.postProcessStack` (ordered Material guid +
Enabled) with `NamedListEditor` / `AssetPicker`. The picker lists post-process
Materials only (open-document domain wins over a stale header).
`attachPostProcessStack` compiles and attaches enabled entries to the active
game camera, skipping (and reporting) a missing, surface-domain or failing
material rather than blacking out the frame. The stack is empty by default.

Engine Settings `postProcessingEnabled` defaults **on**. It gates editor scene
rendering and in-editor Play preview only — not the Material editor's own
post-process preview and not exported games. Disabling it detaches passes
without mutating the scene document. `hardwareScalingLevel` from the same
settings page is applied to the Engine.

Play and export close over surface materials, stack materials (including
disabled entries), transitive Material Functions and texture guids. Saving a
Material writes `domain` onto `header.payload` and `materialDependencies().all`
onto `header.dependencies[]`. The packaged player hydrates those JSON payloads
into `createEngine` (`materialDocuments`, `materialFunctions`,
`postProcessStack`) and forwards `assignMaterial`. After `changescene` /
`ctx.changeScene` the worker emits `activeScene` with the canonical scene guid;
editor Play and the packaged player call `loadScene` / `applySceneEnvironment`
so the destination stack and environment replace the previous scene's. Engine Settings
`postProcessingEnabled` is not applied to exported games — omitted means the
authored stack runs.

## Authoring and runtime behavior

GPU diagnostics map driver line numbers to Custom GLSL body lines when the
processed shader still contains an unambiguous source marker, including inlined
function call paths. Otherwise the original driver message is retained without
an invented line number. Opening the GLSL editor selects a mapped error line.
New edits cancel pending preview builds; dependency refresh marks existing
materials dirty without discarding the displayed generation.
Imported-model texture optimization uses published material readiness rather
than accepting a pending build as proof that replacement textures are bound.

Material pins display compact Float / V2 / V3 / V4 / Texture hints. Bound generic
vectors use the resolved width for connections and default editors. Scalar Split
supports X only. Scene snapshots memoize hashes of immutable byte objects so
transform-only edits do not repeatedly hash texture files; replace the byte object
when an asset changes. Material Output groups Surface,
Emission, Transparency and Geometry pins. Non-surface Details omit surface-only
controls. **Bounds Padding (Local)** expands mesh culling bounds for authored
displacement and restores original bounds on material reassignment; it does not
alter collision shapes. Particle materials preview on a disposable particle
system rather than an unrelated static mesh.

Imported glTF graphs retain base-color/alpha factors, metallic and roughness
factors and packed B/G channels, emissive factors/textures, normal maps, alpha
mode/cutoff and double-sidedness. Color texture samples convert sRGB to linear;
normal and packed data samples remain unconverted. Texture Details exposes the
color-space choice, with legacy graphs retaining their original behavior.
Unsupported material extensions, occlusion or texture-coordinate transforms keep
the Model slot on Babylon's source material instead of substituting a partial
graph. Unrelated images are never borrowed as albedo. Extracted graphs remain
available for explicit editing/assignment.

Custom GLSL readiness includes a bounded GPU shader check on a hidden surface
probe, unattached post-process or inactive particle system before the library
publishes a replacement. GLSL failures retain the
previous material. NullEngine unit tests check graph construction only; browser
checks exercise the GPU compiler.

Surface vertex plumbing applies Morph Targets, Instances and Bones before world
position/normal transforms and authored World Position Offset. Normal Map exposes
UV (mesh UV when unwired) and Strength. Gradient Details edits up to 32 normalized
color stops. Material Function interface edits preserve typed defaults and pin
IDs; selecting an input exposes its numeric default. Byte fingerprints examine
all bytes, so same-size texture replacements refresh dependent meshes.

Material Preview loads closed Material Functions from their `document` chunk,
with unsaved open tabs taking precedence. Registry changes refresh saved bodies
and texture bytes. Texture cache reuse compares content as well as GUID and
sampling settings, preserving outstanding retains when bytes are replaced.
Preview texture references are retained once per byte revision and released on
tab teardown. Newly added Divide / Modulo nodes start with divisor 1 and Power
starts with exponent 1. New Time nodes expose seconds of Babylon scene animation;
legacy nodes preserve the previous 0.6-units-per-second rate.

Custom GLSL nodes created by the editor use node-local `customVersion: 2`, with
stable pin IDs, GLSL variable names and explicit Float / Vector 2 / Vector 3 /
Vector 4 types. The body returns the first output and assigns named additional
outputs, initialized to zero before the body runs. Inputs have ordinary editable
pin defaults. Direct sampler pins and WebGPU are not supported. Derivatives and
discard restrict the node to the fragment stage. Graph validation checks the
interface and function boundary; the GPU compiler checks GLSL syntax and types.
Legacy expression nodes keep their original generic A/B behavior. **Convert to
Function Body** preserves link IDs and the currently inferred vector width.
Changing a variable name does not rewrite authored GLSL; update its references.

Custom nodes display four highlighted read-only lines below their pins. Details
opens the existing expanded multiline dialog with GLSL syntax highlighting,
line numbers, keyboard undo, bracket matching and a coarse-pointer symbol bar.
The return name labels its pin; only input and additional output names are
variables inside the function. Use **Render** to compile Custom GLSL changes.

## Not implemented

- Decal domain is not implemented.
- Motion vectors and object IDs are deferred.
