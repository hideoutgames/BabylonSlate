# Shader graph (P9)

Curated NodeMaterial catalog compiled in `render` (engineplan §14). New package `@babylonslate/shader-graph`: IR + validator, **no Babylon**. Compile-to-`NodeMaterial` lives in `@babylonslate/render`.

## IR

Nodes are a **curated** subset of Babylon NodeMaterial blocks plus a `CustomBlock` escape hatch. Validator uses the same diagnostic model as [scripting.md](scripting.md).

`compileShaderGraph()` stays **metadata only** (`fragmentOutputNodeId`, sampled textures, custom blocks, iPad cost). Do not rebuild this package into a GLSL compiler.

Compile in `render`: `compileShaderGraphForRender` is the throttled live-preview path (do not recompile every keystroke). `compileShaderGraphAtLoad` is never throttled and awaits an injected `forceCompilationAsync`. `applyShaderGraphPreview` then calls `NodeMaterial.Parse` on a default surface (or post-process) template tagged with that IR. Post-process materials are **off by default** and flagged as iPad-costly (engineplan §2.4).

## Authoring

`GraphEditor` from `graph-ui`. `hydrateShaderGraphForEditor` / `shaderPaletteNodes()` inject catalog `__pins` so Add Node is not an empty box (`input.uv` → `uv` out, `output.fragment` → `color` in, math `a`/`b`/`out`, and so on). `serializedToShaderGraph` strips editor `__pins` so the IR payload stays clean.

The Shader document host (`shader-graph-editor`) shows a preview canvas (`data-testid="shader-preview"`). When WebGL is available it creates a Play-mode engine and runs throttled `applyShaderGraphPreview`. jsdom tests pass `enableLivePreview={false}` because `HTMLCanvasElement.getContext` is unimplemented.

Out of the authoring-surface wave: CustomBlock GLSL IDE; assigning the parsed material to a live **scene** mesh from the shader tab (the preview canvas is the host, not the viewport).
