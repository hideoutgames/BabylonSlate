# Scene editing (P6)

Shared-surface design note for viewport, outliner, details, and the edit layer. Authoritative schema: `packages/core/src/scene.ts` (`SCENE_SCHEMA_VERSION = 3`).

## SerializedScene v2

| Field | Role |
| --- | --- |
| `name` | Scene display name |
| `viewportMode` | `"3d"` \| `"2d"` — per-scene default; toolbar toggle always available |
| `settings` | Environment, gravity, timestep, `gameInstanceClass`, grid, `cameraBounds2D`, `editorJoystickEnabled` |
| `actors` | Flat list with `parentId`; hierarchy resolved at apply time |

Each **actor**: `id`, `name`, `classId`, `parentId`, `transform` (position / quaternion rotation / scale), `visible`, `locked`, `components[]`. Details shows **Position**, **Rotation**, and **Scale** as one nowrap XYZ row each. Rotation is **Euler degrees** in the UI; `transform.rotation` stays `[x,y,z,w]` quaternion (`quaternionToEulerDegrees` / `eulerDegreesToQuaternion` in `@babylonslate/core`). 2D drops unused axes (Position/Scale XY, Rotation Z).

Each **component**: `id`, `classId`, `properties` (typed per class in the object-model registry).

**Scene settings** include `physicsWorld` (`"3d"` \| `"2d"`, defaults from `viewportMode`), `grid` (`snapEnabled`, translate/rotate/scale snap, `tileSize`, `tileSubdivisions`), `cameraBounds2D` (`width`, `height`) for the 2D game-camera frame overlay, and `editorJoystickEnabled` (optional on-screen stick that flies/pans the **editor** camera). A scene never mixes physics worlds — see [physics.md](physics.md). Details and Actor Prefab Add Component lists include `RigidBodyComponent` and `ColliderComponent` (defaults from `parseRigidBodyProperties` / `parseColliderProperties`).

## Selection model

`SceneEditingProvider` (`apps/editor/src/context/scene-editing-context.tsx`) is shared by viewport, outliner, and details:

- `selectedActorIds`, `selectActor` (single or additive), `setSelectedActorIds`, `isSelected`
- `gizmoTool` / `setGizmoTool` (`translate` \| `rotate` \| `scale` \| `none`)
- `snapEnabled` / `setSnapEnabled` — live toolbar state; persisted on the scene via `settings.grid.snapEnabled` (`SetSceneSettingCommand`)
- `viewportMode` / `setViewportMode` — live mode synced from `documentViewportMode` so undo/redo of `SetViewportModeCommand` restores the camera, not only the serialized field

Panels never mutate selection independently — they consume `useSceneEditing()`.

## Command layer

Every scene Details / outliner / viewport mutation routes through `applySceneChange` → `diffSceneCommands` → the undo stack. Notable command types:

| Command | Diff trigger |
| --- | --- |
| `SetSceneNameCommand` | `scene.name` |
| `SetViewportModeCommand` | `scene.viewportMode` |
| `SetSceneSettingCommand` | any `settings.*` field (including `grid.snapEnabled`, `gameInstanceClass`) |
| `ReorderComponentCommand` | component list order change with the same ids |
| `SetActorTransformCommand` | gizmo drag / Details transform (merge key `transform:{actorId}`) |

`RemoveActorCommand` stores a single-actor snapshot (not a full subtree). UI deletes that remove a hierarchy emit one remove per actor.

## Gizmo + camera contracts

Both systems are **mode-parametric** via `ViewportMode` from `@babylonslate/core`:

| Mode | Camera | Gizmo |
| --- | --- | --- |
| `3d` | Fly/look: WASD + one-finger (or LMB) look-in-place, pinch/wheel zoom, three-finger pan | Full translate / rotate / scale |
| `2d` | Orthographic; WASD/joystick XY pan, one-finger pan 1:1 with the pointer (hold-then-move marquee), pinch zoom, three-finger pan at the same 1:1 scale (look is a no-op) | XY translate, Z rotate, XY scale; unused axes hidden |

**2D convention** (fixed, left-handed Babylon): content on the **XY plane**, **+Y up**, **+X right**, editor camera at **−Z** looking toward **+Z**. `scene.useRightHandedSystem` stays `false`.

**Per-mode pose memory** (in-session, not serialized): `setMode` snapshots the live camera before switching and restores the destination mode's last pose. 3D stores target / alpha / beta / radius; 2D stores target / ortho half-height / pixel zoom. The first visit to a mode keeps the live target (so 3D→2D still looks at the same place) and applies that mode's defaults. Poses live on the editor camera controller, so they do not dirty the scene document or the undo stack. Save/reopen still uses the default camera.

Implementation: `editor-camera.ts`, `gizmo-host.ts` in `@babylonslate/render`. Gizmos stay Babylon `PositionGizmo` / `RotationGizmo` / `ScaleGizmo` on a utility layer. Restyle (not a custom mesh engine): unlit `disableLighting` + emissive axis `Color3`s (`GIZMO_AXIS_COLORS`, paired with chrome `--axis-x/y/z` in [theming.md](theming.md)), `GIZMO_SHAFT_THICKNESS` 0.45, rotation tessellation 64, planar translate squares at idle alpha ~0.16 / hover ~0.42, hover brightens the active axis. Uniform scale uses a small center cube. Keep `gizmoAxisEnabledFlags` (2D hides unused axes), snap, drag leases / undo coalesce, and `hitTest` blocking camera look. Prefab shares the same host. Selection outline in `selection-outline.ts` stays a cheap mesh outline (color ~`(0.42, 0.78, 1)`, width `0.022`) — not a HighlightLayer.

## EditorSceneSync

`EditorSceneSync` applies scene document edits **incrementally** to the Babylon editor scene (reuse meshes, update transforms, rebuild only on mesh-kind change, despawn removed actors, re-parent).

Invalidates the render scheduler on apply (`"asset"` reason). Viewport wiring also invalidates on **`camera`**, **`gizmo`**, and **`selection`** (see [render.md](render.md)).

Gizmo drags coalesce via `SetActorTransformCommand.mergeKey` (`transform:{actorId}`) — one undo step per gesture.

## Packages

| Package | Responsibility |
| --- | --- |
| `@babylonslate/core` | `SerializedScene`, `SceneSettings`, `ViewportMode`, normalisation |
| `@babylonslate/edit` | Scene commands + `diffSceneCommands`; journal revivers |
| `@babylonslate/render` | Editor tools: camera, gizmos, grid, outline, sync, gestures |
| `@babylonslate/editor-kit` | Property grid, tree view, panel frame, toolbar, asset picker, class picker, input mapping editor |
| `apps/editor` | Viewport, Outliner, Details, Place Actors catalog, Actor prefab tab; `applySceneChange`. **Windows** (global toolbar, left of Focus) lists these dock tabs and toggles them; reopen restores addPanel-relative last placement. |

## Outliner and Details visuals

- **Outliner** (`TreeView`): 32px rows, type icon from `resolveActorTypeVisual` (Actor color; mesh/light/camera glyphs for engine `Actor` placeholders; user classes use the parent engine icon), selected row `bg-primary/20` + `border-l-primary`. **Search** and **+** share one row. Visibility/lock toggles are compact `sm` controls. Hold ~250ms arms reorder (`onReparent`); move before that scrolls. **Double-tap** frames the actor (`frameActor` via viewport context). **+** opens a **Place Actors** `CatalogDialog` (Shapes, Lights, Camera, Empty, Project assets) with the same type icons. Spawned lights create a Babylon `PointLight` / `DirectionalLight` / `SpotLight` (`authoredLight:<actorId>`) and dim the default hemi; spawned cameras create an `ArcRotateCamera` (`authoredCamera:<actorId>`). The editor orbit camera stays in control (`stealActiveCamera: false`); Play makes the first authored camera `activeCamera`. Place Actors copies class prefab `SerializedGraph.components` from the open tab **or** the disk class document.
- **Details** (`PropertyGrid`): stacked **title-above-control** rows (`Field` vertical) with compact inspector spacing. Labels are Title Cased (`meshKind` → `Mesh Kind`, `2D camera width` → `2D Camera Width`). Category headers use `--secondary`. Vector axes use `--axis-x/y/z` on one nowrap row under the title (letters live on `NumericDragField`). Scalar number rows keep a compact unlabeled scrub handle so the title is not repeated. Checkboxes are compact (`size-4`) under the title. Reset is a compact icon button (`↺`) on the title line, not the word Reset. Controls use `--chrome-row` (28px). **Add Component** uses the same catalog chrome, grouped Rendering / Camera / Physics. Numeric rows (`NumericDragField`) keep an empty typed draft; emptying does not commit `0` — blur restores the last committed number.
- **Typed component rows** (`apps/editor/src/lib/component-property-rows.ts`): `MeshComponent.assetGuid` / Sprite / Tilemap / Widget / AnimationGraph open `AssetPicker` (button shows the asset name, stores the guid). Sprite/Tilemap `sortingLayer` is an enum from project `twoD.sortingLayers`. `RigidBodyComponent.motionType` is an enum; `gravityScale` / damping use sliders (0–10). `ColliderComponent.shape` flattens to kind plus half-extents / radius (polygon / mesh point clouds are not JSON text); `friction` / `restitution` are 0–1 sliders; `layer` / `mask` are 32-bit `FlagsField` toggles (Layer 0–31). `LightComponent.color` is a native color row; `intensity` is a 0–16 slider. Camera FOV (1–179) and orthographic size (0.1–50) are sliders. Scene **Game Instance** uses `ClassPicker` filtered to GameInstance lineage.
- **Viewport overlay**: toolbar island on `--popover` with a shadow so it separates from the 3D view. Gizmo / snap / joystick / Focus pressed states use accent fill + primary border.

## 2D specifics

- **Marquee**: hold ~250ms then drag in 2D selects actors whose origin falls inside the rect (`viewport-gestures.ts`, `two-d.ts`). Immediate one-finger drag **pans** 1:1 with the pointer (orthographic frustum over CSS canvas size, so hardware scaling does not change feel). 3D one-finger drag looks the camera instead.
- **Tile grid**: major lines at `settings.grid.tileSize`; minor lines at `tileSubdivisions` between majors (`editor-grid.ts`).
- **`cameraBounds2D`**: rectangle drawn in the viewport for the game camera frame.
- **`pixelsPerUnit`**: project setting (default 100); drives pixel-perfect ortho bounds and grid snapping.
- **Pixel-perfect sampling**: when `twoD.pixelPerfect` is on in 2D mode, `setPixelPerfect` also runs `applyPixelArtSamplingToScene` (nearest sampling, clamp wrap, anisotropy 1) on every texture currently on the Babylon scene.
- **Sorting layers**: ordered list in Project Settings (`NamedListEditor`); `(sortingLayer, orderInLayer)` compiled to one `alphaIndex` sort key; rendering groups reserved for coarse background / world / foreground / UI separation (`sorting.ts`).
- **Locked actors**: `isPickable = false` and the viewport gizmo attaches only to pickable meshes. **Locking an actor immediately drops it from `selectedActorIds`** (Outliner lock toggle and Details Locked). Unlock does not reselect. Details then shows scene settings when nothing remains selected.

## Actor Prefab tab

Prefab is a **window of the class document**, not a fourth chrome `DocumentKind`. Default class layout:

| Dock | Panels |
| --- | --- |
| Center group | **Graph** and **Prefab** as siblings (`direction: "within"`). Selecting Prefab fills the workspace like Viewport does on a Scene. |
| Left | **Components** above **Class** (compact member tree; inline **+** on Functions / Variables / Events / Interfaces). |
| Right / bottom | Inspector, Compiler Results |

The Prefab viewport reuses `ViewportToolbar` + `createEngine` (unlit gizmos, fly/look camera, joystick when enabled). The canvas is full-size, not a 160px sidebar strip, and stays dark like the Scene viewport. Component add/remove/reorder writes `SerializedGraph.components` through `applyGraphChange` (`graph.setComponents`). Place Actors instantiates those components when spawning a Class asset from an open tab **or** from the class file on disk.

**Focus** (toolbar toggle) closes dock tabs that are not on the Engine Settings Focus keep-list. Class default is Graph only; Scene default is Viewport. Keep-listed tabs stay only if they were already open.

Play instantiates the startup/main `SerializedScene` even when no scene tab is open (`collectPlayStartupScene` / `project.json` `scenes[0]`), and binds `settings.gameInstanceClass`. See [physics.md](physics.md) and [render.md](render.md).

See [command-layer.md](command-layer.md) for undo/journal and [gestures.md](../design/gestures.md) for touch contracts.
