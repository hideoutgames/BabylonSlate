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

The preview is a disposable Scene and registered view on the **app-lifetime
Engine** — never a second WebGL context. `createMaterialPreviewScene` builds
cube, sphere, cylinder, cone, plane, or a custom Model, and applies either the
material or a camera post-process.

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

## Runtime

`MeshComponent.materialGuid` binds a Material; imported models also carry
ordered `materialSlots`. The runtime emits the existing `assignMaterial` bridge
command, optionally with a `componentId`. The renderer applies a whole-actor
assignment across a multipart actor's descendants and a component assignment to
one named mesh, re-applies after a mesh rebuild, and releases records on
despawn.

Scene settings carry an ordered `postProcessStack`. `attachPostProcessStack`
compiles and attaches enabled entries to a camera in order, skipping (and
reporting) a missing, surface-domain or failing material rather than blacking
out the frame. The stack is empty by default: a full-screen pass is the classic
mobile fill-rate cost.

## Not implemented

- **Custom GLSL** is in the catalog with a typed, generated signature, but the
  authoring surface for its body is not built. It is classified expensive and
  is GLSL-only; no WGSL implementation exists, so WebGPU portability is not
  claimed for it.
- Vertex-stage authoring (world position offset) has no output channel yet.
- Decal domain is not implemented.
