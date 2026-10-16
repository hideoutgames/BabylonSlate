# Scene Layers

SceneLayer overlays: unlit 2D documents stacked on a Play session compositor above the single world Scene.

## Product decisions

- A SceneLayer is a HUD overlay. It is not a second world scene, not additive streaming, and not the removed UserInterface / ADT HUD. Never re-add `@babylonslate/ui-runtime`, UserInterface, WidgetComponent or Babylon GUI.
- Play loads one world Scene at a time; layers live on a session compositor drawn after the world camera and its post-process, so world PP never hits overlays.
- Scene-owned layers spawn from `SceneSettings.sceneLayers` (`{ assetGuid, zOrder, enabled }[]`) and despawn with that world. Graph-created layers (`ownerSceneGuid === null`) survive world travel until Remove / Clear / Stop. One asset may run as several instances.
- Widgets are actor components (`2D*`), not a separate widget asset system.

## Ownership

| Area | Source |
| --- | --- |
| Schema, editor conversion (`sceneLayerToEditorScene`, `editorSceneToSceneLayer`) | [`packages/core/src/scene-layer.ts`](../../../packages/core/src/scene-layer.ts) |
| Component placement authority (`ENGINE_COMPONENT_DESCRIPTORS`) | [`packages/core/src/engine-components.ts`](../../../packages/core/src/engine-components.ts) |
| Layer lifecycle | [`packages/runtime/src/scene-layers.ts`](../../../packages/runtime/src/scene-layers.ts) |
| Layout, anchors, safe area, virtualization, focus, pointer/scroll input | [`packages/runtime/src/scene-layer-overlay.ts`](../../../packages/runtime/src/scene-layer-overlay.ts), [`scene-layer-layout-gate.ts`](../../../packages/runtime/src/scene-layer-layout-gate.ts) |
| Layer physics query routing (`callerSceneLayerId`) | [`packages/runtime/src/runtime-host-physics.ts`](../../../packages/runtime/src/runtime-host-physics.ts) |
| Compositor (extra Babylon `Scene`s on the shared Engine) | [`packages/render/src/scene-layer-compositor.ts`](../../../packages/render/src/scene-layer-compositor.ts) |
| Play command allowlist, overlay snapshot flag | [`packages/bridge/src/play-engine-commands.ts`](../../../packages/bridge/src/play-engine-commands.ts), [`snapshot-buffer.ts`](../../../packages/bridge/src/snapshot-buffer.ts) |
| Graph nodes | [`packages/scripting-nodes/src/scene-layer.ts`](../../../packages/scripting-nodes/src/scene-layer.ts) |
| Editor document and Place Actors host filter | [`apps/editor/src/lib/scene-layer-document.ts`](../../../apps/editor/src/lib/scene-layer-document.ts), [`place-actors.ts`](../../../apps/editor/src/lib/place-actors.ts) (`placeActorsForHost`) |

## Document and editor

- Content Browser type `SceneLayer` → document kind `scene-layer`: actors, folders, 2D gravity, `physicsEnabled` (default false), post-process stack, `layerBounds` (default 32×18). Always 2D.
- The editor tab converts to a locked 2D `SerializedScene` so Viewport / Outliner / Details reuse the scene shell; Save converts back. `physicsEnabled` travels as editor-only `layerPhysicsEnabled`.
- The tab is one locked 2D Unlit viewport with an opaque black clear, not the Play compositor. It hides the 3D/2D toggle, Move/Rotate/Scale and shading menu, and omits Default Camera, fog/IBL, lights and the physics-world picker.
- Layer Width/Height (the orange frame, `cameraBounds2D` in editor, `layerBounds` on disk) is the design canvas. Play stretches it to the full viewport; authoring is WYSIWYG.
- Selection uses the 2D transform box (`overlay-box`). Resize writes actor XY scale; on 2D Text / Rich Text it writes `wrapWidth` / `wrapHeight` instead.

## Object model and placement

- `SceneLayer` extends `BObject`; `SceneLayerActor` extends `Actor`. Overlay actors live in the same `World`, tagged `sceneLayerId`, so graphs and Get All Actors see them. Change Scene must not destroy them.
- Instance actor guids are `<layer guid>:<authored id>` with references remapped ([object-model.md](object-model.md#guids-and-identity)); component ids stay authored. Repeated actor ids fail to load.
- Every `2D*` component is overlay-only (`SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS`); world-only components (Landscape, Foliage, water, Skybox, cameras, lights, fog, streaming, Movement, buoyancy …) are stripped from layers and refused at runtime. `ENGINE_COMPONENT_DESCRIPTORS` decides placement for Add Component, Place Actors, serialization and instantiation.
- Spawn Actor and world instantiation never create `SceneLayerActor`. World Place Actors uses `overlay: false` and never lists overlay stamps.

## Runtime and render

- Readiness is per layer instance: `sceneLayerLoading` → `sceneLayerRealized` → `sceneLayerReady` for that exact load id. Begin Play, ticks, physics and playback wait for owner readiness; late acknowledgements for removed/superseded ids are ignored. Create Scene Layer resolves when ready (30 s deadline).
- Each layer camera is an independent orthographic HUD camera at `(0, 0, -10)` with `±layerBounds/2` ortho. Never parent overlay cameras or meshes to the world camera or copy world view/projection; re-bind the pose if another owner changed it.
- Draw order: world, then layers by `zOrder` (ties by instance id). Layers without PP clear depth only; layers with PP render to an RTT through the coordinator FrameGraph, then alpha-composite (targets keep alpha).
- Overlay identity is `sceneLayerId` / `SNAPSHOT_FLAG_OVERLAY` / overlay-only mesh kind. Overlay visuals never instantiate on the world Scene; leftover `actor-*` world copies are disposed.
- `2DTexture` / `2DMaterial` share the Engine `ResourceCache`; overlay sampling must not steal a world texture wrapper. Overlay materials compile scene-local unlit (separate cache key).
- `SceneLayerOverlay` re-indexes only when `World.structuralRevision` changes; `SceneLayerLayoutGate` skips layout unless a recorded input changed.

## Physics and input

- Physics is opt-in per asset. Each enabled instance gets its own Rapier 2D world, independent of the world and other layers; disabled layers have no world (bodies, colliders and overlap events do nothing).
- Traces, sweeps and overlaps answer from the caller's world; `showcollision` draws layer colliders in that layer's own scene.
- Picking walks layers high → low `zOrder`, honoring Hit Test (Ignore / Block / Pass Through), then the world. `2DButton` opts an actor into pointer events and is the only source of pointer graph events (no `onTouch*` nodes). Engine Settings `touchMinTargetPx` widens pick AABBs, not visuals.
- Focus navigation uses project Input assets; focus state is session-only and never saved.

## Components with fixed contracts

- `2DAnchor` maps from `layerBounds` onto the Play frustum (identity plus offset). The uppermost anchor in a subtree wins; anchors never bake into positions.
- 2D Text / Rich Text use glyph-quad meshes (Bitmap default, MSDF when the Font has both chunks), not Babylon GUI or `TextRenderer`. Size is px / `pixelsPerUnit`.
- Style (Opacity / Tint) and component motion travel separately from structural mesh assignments, so tweens never rebuild visuals.
- 2D Painter, Joystick, form controls, virtualized collections and masks are overlay-only; script-generated painter commands are never written back to the project.
- Export collects layer documents from every Play-library scene's `sceneLayers` and graph `assetRef("SceneLayer")` defaults, including RichText `[img=<guid>]` textures inside markup.
