# Materials and Material Functions

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

`MaterialDocument` (v2) carries `domain` (`surface` | `postProcess`),
`shadingModel`, `blendMode`, `twoSided`, `alphaCutoff`, `preview` and the graph.
`MaterialFunctionDocument` (v1) carries typed `inputs` / `outputs` with **stable
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

## Validation

`validateMaterialDocument` / `validateMaterialFunctionDocument` report node, pin,
type, cardinality, cycle, domain, stage, capability, missing-asset and function
errors. Codes are `material.*`, each anchored to a node, pin or edge so the
Compiler Results panel can focus the offender. `material.postProcessCost` is a
warning, not a blocker.

## Lowering and compilation

`lowerMaterialDocument` produces a deterministic `MaterialBuildPlan`:
topologically ordered operations, explicit operands (including inserted splats),
texture bindings, dependencies, cost features and a content hash that ignores
node positions. Material Function calls are **inlined** here under namespaced
operation ids (`callNodeId/innerNodeId`) because Babylon has no runtime function
object; each inlined operation still maps back to its call node.

`compileMaterialPlan` instantiates one or more real Babylon blocks per operation
and connects actual connection points. The compiler owns plumbing the graph does
not author:

- **Surface**: position/normal/uv attributes, world and clip-space transforms,
  view direction, and a `PBRMetallicRoughnessBlock` unless the material is unlit.
- **Post process**: the `position2d` fullscreen quad, its vertex output, and the
  screen UV remapped from clip space. Babylon still requires a vertex output in
  post-process mode.

Babylon reports build failures through `onBuildErrorObservable` rather than
throwing, so the compiler subscribes and turns them into diagnostics. Blocks
Babylon lacks are composed from existing ones rather than raw source — `fwidth`
is derivatives plus absolute values plus an add, `log2` is a scaled natural log,
`inversesqrt` is a reciprocal square root.

`MaterialLibrary` caches per Scene keyed by asset guid plus plan hash and
refcounts instances. A Babylon material belongs to one Scene, so the editor
viewport, a preview tab and a Play session each hold their own. A new material
replaces the old one only after it builds, so a failed edit leaves the previous
material on screen.

## Preview and the Render button

The preview is a disposable Scene on the **app-lifetime Engine** — never a
second WebGL context. `createMaterialPreviewScene` builds cube, sphere,
cylinder, cone, plane, or a custom Model, and applies either the material or a
camera post-process. Present goes through `camera.outputRenderTarget` (an RTT)
and a 2D blit onto `material-preview-canvas`. Do **not** `registerView` or
default-framebuffer `scene.render()` — those overwrite the Scene viewport and
Play overlay, which share that Engine. Prefab Preview is on that Engine too
(`p17-shared-prefab-engine`; today it is still a separate Engine). Orbit / pinch / wheel attach to the preview canvas
only (`attachMaterialPreviewGestures`); never `camera.attachControl`, which
Babylon binds to the Engine input element (Scene / Play). Hidden Material tabs
and in-editor Play freeze present.

Mesh / **Render** / status live in a compact overlay chip on the canvas
(`material-preview-overlay`) — viewport-style `ToggleGroup` `size="sm"` icons
and a `size="sm"` Render button, not a `ToolbarStrip` of 44px controls.

The default Material dock stacks **Preview** over **Details** on the left
(~25% width, 50/50 height) so **Graph** keeps about 75% width. Compiler Results
still sit under the graph. Persisted `layout.json` is unchanged until reset.

`materialPreviewReducer` is generation safe:

```
clean → dirty → queued → lowering → gpuCompiling → ready | error
```

Every edit bumps the generation. Cheap graphs auto-queue after a trailing
debounce; expensive ones stay dirty until **Render**. Render is disabled while
clean, queued or compiling, and whenever the newest generation is already on
screen. A result from an older generation still becomes the last good image
unless a newer compile is already in flight, so the preview is never blank while
editing.

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
the Class graph (`PinDefaultPreviewWidget`). Catalog `defaultValue` (and
`colorHint` swatches) hydrate onto `__pins`; authored overrides persist as
`default:<pinId>` number arrays on the node. Widgets hide when that pin is
wired. Lowering prefers the authored override, then the catalog default;
unwired pins with neither stay unset (Normal, Alpha Clip).

Details is selection-aware:

- **No node selected:** Domain, Shading Model, Blend Mode, Two Sided (and Alpha
  Cutoff when masked) plus the cost line.
- **A node selected:** those material settings hide; the panel shows only that
  node's properties and unconnected pin-default editors.

## Custom GLSL

`custom.glsl` is an **expression-only** fragment helper. The selected-node
Details panel edits a persisted `body` (Textarea) with a generated typed
signature `result = fn(a, b)`. The validator rejects empty bodies, oversized
source, declarations, preprocessor directives and forbidden globals, and
reports `material.capability` on WebGPU (`customGlsl: false`). Compiler
Results show `material.customGlsl`. Playwright wires the validated node
into Metallic with tap-to-connect (force-click so the dock sash cannot
steal the pin) and asserts the preview compiles to `data-status="ready"`.
Render realises the node through Babylon `CustomBlock`; the expression
participates in the plan hash so a body edit invalidates the cache.

## Inline Texture Sample

`texture.sample` and `texture.sampleLod` may store `textureGuid` on the node
while still accepting a wired `param.texture`. An unwired texture input is
valid only when that asset is set. The GUID is part of
`materialDependencies()`, header `dependencies[]`, and the Play/export
closure. Selected Texture Sample nodes expose an `AssetPicker` in Details.

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

`MeshComponent.materialGuid` binds a Material; imported models also carry
ordered `materialSlots`. Play emits `assignMaterial`, optionally with a
`componentId` (slot ids / `actor-<slot>` names). The renderer applies a
whole-actor assignment across a multipart actor's descendants and a component
assignment to one named mesh, re-applies after a mesh rebuild, and releases
records on despawn. Editor viewports (scene and Prefab) do **not** use that
Play path: `EditorSceneSync` binds the same guid onto `editorActor:<id>` /
`editorActor:<id>|<componentId>` through `MaterialLibrary.resolveMaterial`.
The shared browser fixture asserts the authored material on Scene, Prefab,
overlay Play, Preview Build, and the packed player rather than relying only on
command-record tests.

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

## Not implemented

- Vertex-stage authoring (world position offset) has no output channel yet.
- Decal domain is not implemented.
- Motion vectors and object IDs are deferred.
