# Shader graph (P9)

Curated NodeMaterial catalog compiled in `render` (engineplan §14). New package `@babylonslate/shader-graph`: IR + validator, **no Babylon**. Compile-to-`NodeMaterial` lives in `@babylonslate/render`.

## IR

Nodes are a **curated** subset of Babylon NodeMaterial blocks plus a `CustomBlock` escape hatch. Validator uses the same diagnostic model as [scripting.md](scripting.md).

Compile in `render`: `compileShaderGraphForRender` is the throttled live-preview path (do not recompile every keystroke). `compileShaderGraphAtLoad` is never throttled and awaits an injected `forceCompilationAsync` (Babylon `NodeMaterial.Parse` on a real scene, or a test double). Post-process materials are **off by default** and flagged as iPad-costly (engineplan §2.4).

## Authoring

`GraphEditor` from `graph-ui` with a shader node-type map. Preview host is main-thread Babylon; the IR package stays headless.
