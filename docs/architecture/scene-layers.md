# SceneLayer overlays

Unlit 2D overlay documents stacked on a session compositor. Not a second world scene, not additive world streaming, and not a revival of the removed UserInterface / ADT HUD.

Schema: `packages/core/src/scene-layer.ts`. Runtime: `RuntimeDriver` compositor APIs. Render: extra Babylon `Scene`s on the shared Engine (`packages/render/src/scene-layer-compositor.ts`).

## One world Scene, overlay stack

Play still loads **one world Scene** at a time (`changeScene` / `changescene` swap that world). Overlay instances live on a session **SceneLayer Viewport** owned by Play/runtime, drawn **after** the world camera (and its post-process) so world PP never hits overlays.

```mermaid
flowchart TB
  subgraph play [Play framebuffer]
    WorldScene["World Scene + world PP"]
    Comp["SceneLayer Viewport"]
    L0["Layer z=0 + optional PP"]
    L1["Layer z=1 + optional PP"]
    WorldScene --> Comp
    Comp --> L0
    L0 --> L1
  end
  Driver["RuntimeDriver"] -->|"create / remove / clear"| Comp
  SceneA["World scene settings.sceneLayers"] -->|"on realize / on destroy"| Driver
  Graph["Create / Remove / Clear / Register PP"] --> Driver
```

Graph-created layers (`ownerSceneGuid === null`) survive world travel until Remove / Clear / Play stop. Scene-owned layers spawn from `SceneSettings.sceneLayers` and despawn when that world scene unloads. The same asset may exist as two instances (scene-owned + graph-created). Clear removes every layer.

## Asset

Content Browser type `SceneLayer` → document kind `scene-layer`. Payload is a slim scene cousin (actors, folders, 2D gravity, post-process stack). Always 2D. World `SceneSettings.sceneLayers` is `{ assetGuid, zOrder, enabled }[]`.

Editor tabs convert to a locked 2D `SerializedScene` (`sceneLayerToEditorScene`) so Viewport / Outliner / Details reuse the scene shell. Save writes `SerializedSceneLayer` (`editorSceneToSceneLayer`).

DockView: Viewport, Outliner, Details, Output Log. Hide the 3D/2D toolbar toggle; lock Unlit shading. Overlay Details (nothing selected): Name, Gravity, Timestep, Post Process. No Default Camera, fog/IBL, lights, or 3D/2D physics-world picker.

## Object model

`SceneLayer` extends `BObject` (`kind: "object"`). `SceneLayerActor` extends `Actor`. Overlay actors stay in the same `World` (same tick/snapshots) tagged `sceneLayerId`. `applyChangeScene` must not destroy them.

**Denylist only** (Add Component, Place Actors, serialize skip, overlay instantiate): Skybox, Camera, Light. Everything else is allowed, plus overlay-only `2DAnchor`, `2DTexture`, `2DMaterial`, `2DButton`. User Class prefabs that inherit `SceneLayerActor` follow the same denylist (strip Camera/Light/Skybox on Place). Spawn Actor and world-scene instantiate never create `SceneLayerActor` (or subclasses) in the world.

Place Actors in a SceneLayer document: `SceneLayerActor` and subclasses. World Scene Place Actors excludes them.

## Overlay 2D physics

Overlay actors always simulate in a dedicated Rapier 2D world on the Play session, independent of the world scene’s `physicsWorld` (Havok 3D vs Rapier 2D). Overlay and world bodies do not overlap. Tilemap collision / Blocking Volume on overlay actors go to this Rapier world.

## Render

Extra unlit ortho `Scene`s on the shared Engine:

- World: `autoClear = true`, existing camera PP unchanged.
- Each live SceneLayer: orthographic camera, `lightsEnabled = false`, unlit, no world PP.
- Draw order: world, then layers by `zOrder` (stable by instance id on ties).
- Layer with no PP: `autoClear = false` on color; clear depth so 2D quads sort.
- Layer with PP: render to an RTT, run that camera stack, alpha-composite onto the framebuffer (Babylon camera PP would otherwise replace the world). Engine Settings `postProcessingEnabled` still gates overlay PP in editor Play only.

The SceneLayer editor tab is a normal 2D viewport (one Babylon scene), not the Play compositor.

## Hit test and 2DAnchor

`HitTest` on `2DButton`, `2DMaterial`, and `2DTexture`: Ignore (default on texture/material), Block (default on button), Pass Through. `2DButton` is interaction-only: a sibling `2DTexture` / `2DMaterial` / Sprite / Mesh is the hit visual; otherwise Play emits a default unit quad.

Play overlay walks layers high `zOrder` → low, `scene.pick` each overlay scene, honors HitTest, then optionally the world. Overlay scenes participate in pointer-move picks for hover; world scenes keep `skipPointerMovePicking: true`.

`2DAnchor` pins actor XY to a 9-point layer/screen origin plus offset. On canvas / resolution change the worker reapplies XY so Get Actor Location matches the visual.

Button graph events on SceneLayerActor palettes only: Event On Mouse Enter / Leave / Click / Press Start / Press End (`onMouseEnter`, `onMouseLeave`, `onClick`, `onPressStart`, `onPressEnd`). Old HUD event ids stay unmapped.

## Graph nodes

Category `scene-layer` (GameInstance and other graphs; instances live on the session compositor):

| Node | Runtime |
| --- | --- |
| Create Scene Layer | `ctx.createSceneLayer(guid, zOrder)` |
| Remove Scene Layer | Destroy instance + actors; no-op if already gone |
| Clear Scene Layer | Remove all |
| Register Scene Layer Post-Processing | Append a `postProcess` Material |
| Unregister Scene Layer Post-Processing | Missing material: error diagnostic / Output Log, Play continues |

Register/Unregister pickers require `domain === "postProcess"`.

## Play / export / player

Collect SceneLayer documents from every Play-library scene’s `sceneLayers` plus graph `assetRef("SceneLayer")` pin defaults. Pack textures, sprites, tilemaps, audio, particles, and materials those layer actors reference (same closure as a 2D scene), including `2DTexture.textureGuid` and `2DMaterial.materialGuid`. Player `activeScene` still swaps **world** only; compositor commands follow the worker.

Do not re-add `@babylonslate/ui-runtime`, UserInterface, WidgetComponent, or Babylon GUI. `p9-ui-anchoring` stays “do not rebuild” for HUD widgets; `2DAnchor` is overlay-actor layout only.
