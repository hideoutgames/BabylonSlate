---
name: babylonjs
description: "Babylon.js engine work in Haptic: packages/render and engine code inside editor files, including rendering, shaders, scene lifecycle, meshes, materials, cameras, animation, asset loading and physics. Use it for any such change, bug or investigation, even when Babylon is not named; editor chrome alone uses the editor UI skills."
---

# Babylon.js

## Version

`@babylonjs/core`, `@babylonjs/loaders` and `@babylonjs/serializers` are **9.29.0**; `@babylonjs/havok` is 1.3.14. Core is pinned with one pnpm patch (`pnpm-workspace.yaml`, `patches/@babylonjs__core@9.29.0.patch`). There is no `@babylonjs/gui`, `@babylonjs/inspector` or `@babylonjs/materials`. Online docs and examples may describe another version: check the typings in `node_modules/@babylonjs/core` before using an API.

## Read first

- [render.md](../../reference/architecture/render.md): Engine ownership, the frame path, resources, lighting, Play presentation, and the patch and workarounds to review when the pin moves.
- [physics.md](../../reference/architecture/physics.md), [shader-graph.md](../../reference/architecture/shader-graph.md), [particles.md](../../reference/architecture/particles.md) and [scene-layers.md](../../reference/architecture/scene-layers.md) for those subsystems.
- Package import boundaries: `no-restricted-imports` in `eslint.config.js`.

## Invariants

- **One Engine per project** (`packages/render/src/create-engine.ts`). Previews and thumbnails render to an RTT on it; never create a second WebGL or WebGPU context. The only exceptions are the Preview Build iframe and the Homepage launcher ([render.md](../../reference/architecture/render.md#one-engine-per-project)).
- **Draw only through the forward FrameGraph** (`ForwardSceneFrameGraph` in `framegraph-forward-scene.ts`). There is no `Scene.render` fallback; render.md lists what graph preparation rejects.
- **Construct textures only in `ResourceCache`** (`resource-cache.ts`). The ESLint rule `boundary/render-texture-cache` rejects `new Texture` elsewhere in `packages/render`; renderer-owned targets reserve through `beginManagedRenderAllocation`.
- **Create shadows only through `SceneShadowController`** (`shadow-controller.ts`). An unmanaged shadow generator makes graph preparation reject.
- **Models are GLB.** `gltf-loader.ts` is the only place the glTF 2.0 loader and its extensions are registered, and model assets load through `loadModelContainer` in `model-container.ts`. OBJ, FBX and STL convert to GLB at import.
- **No Babylon GUI.** Editor chrome is React, in-game UI is SceneLayers, and the removed game HUD / UserInterface system stays removed.
- **Babylon stays out of the game worker**, except physics on its private NullEngine ([architecture.md](../../reference/architecture.md#threading-and-data-flow)). Graph execution emits commands and never touches Babylon.
- **Coordinates**: Babylon is left-handed and Y-up, and its APIs take radians; `scene.useRightHandedSystem` stays false (`editor-camera.ts`). Scene documents store rotation as a quaternion `[x, y, z, w]`, and the UI shows Euler degrees ([scene-editing.md](../../reference/architecture/scene-editing.md)).
- **No generated artwork.** Runtime primitives and debug geometry are product features, but textures, models and icons are never generated ([no-ai-artwork.md](../../rules/no-ai-artwork.md)).

## Documentation

[references/doc-urls.md](references/doc-urls.md) lists checked documentation pages and the raw-markdown pattern for fetching them.
