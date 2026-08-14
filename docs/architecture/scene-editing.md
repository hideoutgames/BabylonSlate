# Scene editing (P6)

Shared-surface design note for viewport, outliner, details, and the edit layer. Authoritative schema: `packages/core/src/scene.ts` (`SCENE_SCHEMA_VERSION = 3`). **One scene document tab at a time** — opening a scene closes the previous (Unsaved: Save / Discard / Cancel). Graphs and Content Browser stay.

## SerializedScene v3

| Field | Role |
| --- | --- |
| `name` | Scene display name |
| `viewportMode` | `"3d"` \| `"2d"` — per-scene default; toolbar toggle always available |
| `settings` | Environment, gravity, timestep, `gameInstanceClass`, grid, `cameraBounds2D`, `editorJoystickEnabled` |
| `actors` | Flat list with `parentId`; hierarchy resolved at apply time |

Each **actor**: `id`, `name`, `classId`, `parentId`, `transform` (position / quaternion rotation / scale), `visible`, `locked`, `components[]`. Details shows **Position**, **Rotation**, and **Scale** as one nowrap XYZ row each. Rotation is **Euler degrees** in the UI; `transform.rotation` stays `[x,y,z,w]` quaternion (`quaternionToEulerDegrees` / `eulerDegreesToQuaternion` in `@babylonslate/core`). 2D drops unused axes (Position/Scale XY, Rotation Z).

Each **component**: `id`, `classId`, `properties` (typed per class in the object-model registry).

**Scene settings** include `physicsWorld` (`"3d"` \| `"2d"`, defaults from `viewportMode`), `grid` (`snapEnabled`, translate/rotate/scale snap, `tileSize`, `tileSubdivisions`, `showGrid`), `cameraBounds2D` (`width`, `height`) for the 2D game-camera frame overlay, and `editorJoystickEnabled` (optional on-screen stick that flies/pans the **editor** camera). `grid.showGrid` is additive (missing keys normalize to true). A scene never mixes physics worlds — see [physics.md](physics.md). Details and Actor Prefab Add Component lists include `RigidBodyComponent` and `ColliderComponent` (defaults from `parseRigidBodyProperties` / `parseColliderProperties`).

## Selection model

`SceneEditingProvider` (`apps/editor/src/context/scene-editing-context.tsx`) is shared by viewport, outliner, and details:

- `selectedActorIds`, `selectActor` (single or additive), `setSelectedActorIds`, `isSelected`
- `gizmoTool` / `setGizmoTool` (`translate` \| `rotate` \| `scale` \| `none`)
- `dragSelectActive` / `setDragSelectActive` — one-shot Drag Select; unpresses after the next tap or marquee
- `snapEnabled` / `setSnapEnabled` — live viewport settings; persisted via `settings.grid.snapEnabled`
- `gridVisible` / `setGridVisible` — live viewport settings; persisted via `settings.grid.showGrid` (default true)
- `joystickEnabled` / `setJoystickEnabled` — live viewport settings; persisted via `settings.editorJoystickEnabled`
- `viewportMode` / `setViewportMode` — live mode synced from `documentViewportMode` so undo/redo of `SetViewportModeCommand` restores the camera, not only the serialized field

Panels never mutate selection independently — they consume `useSceneEditing()`.

## Command layer

Every scene Details / outliner / viewport mutation routes through `applySceneChange` → `diffSceneCommands` → the undo stack. Notable command types:

| Command | Diff trigger |
| --- | --- |
| `SetSceneNameCommand` | `scene.name` |
| `SetViewportModeCommand` | `scene.viewportMode` |
| `SetSceneSettingCommand` | any `settings.*` field (including `grid.snapEnabled`, `grid.showGrid`, `gameInstanceClass`) |
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

**Per-mode pose memory** (in-session, not serialized): `setMode` snapshots the live camera before switching and restores the destination mode's last pose. 3D stores target / alpha / beta / radius; 2D stores target / ortho half-height / pixel zoom. The first visit to a mode keeps the live target (so 3D→2D still looks at the same place) and applies that mode's defaults. Poses live on the editor camera controller (`exportSessionState` / `importSessionState`) and on the document `SceneEditingProvider` (a ref, so Focus exit `fromJSON` and Windows close/reopen of Viewport or Prefab can remount the canvas without resetting the view). They do not dirty the scene document or the undo stack. Closing the document tab still uses the default camera.

Implementation: `editor-camera.ts`, `gizmo-host.ts` in `@babylonslate/render`. Gizmos stay Babylon `PositionGizmo` / `RotationGizmo` / `ScaleGizmo` on a utility layer. Restyle (not a custom mesh engine): unlit `disableLighting` + emissive axis `Color3`s (`GIZMO_AXIS_COLORS`, paired with chrome `--axis-x/y/z` in [theming.md](theming.md)), `GIZMO_SHAFT_THICKNESS` 0.45, rotation tessellation 64, planar translate squares at idle alpha ~0.16 / hover ~0.42, hover brightens the active axis. `scaleRatio` defaults to `DEFAULT_GIZMO_HANDLE_SCALE` 2.8 (2.4 was too small, 3.6 too large). Invisible leaf colliders scale by `GIZMO_COLLIDER_SCALE` 2.5; visible translate cones and scale boxes by `GIZMO_END_CAP_SCALE` 1.6 (shafts stay thin). Uniform scale keeps Babylon’s small unlit octahedron (`GIZMO_UNIFORM_COLOR` on `ScaleGizmo.coloredMaterial`) — do not `setCustomMesh` a world-sized cube. Keep `gizmoAxisEnabledFlags` (2D hides unused axes), snap, drag leases / undo coalesce, and `hitTest` blocking camera look. Prefab shares the same host. Selection outline in `selection-outline.ts` stays a cheap mesh outline (color ~`(0.42, 0.78, 1)`, width `0.022`) — not a HighlightLayer.

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
| `apps/editor` | Viewport, Outliner, Details, Place Actors catalog, Actor prefab tab; `applySceneChange`. **Windows** (global toolbar, left of Focus) lists these dock tabs and toggles them; reopen restores addPanel-relative last placement. P12 live Editor Utility tabs (`p12-editor-extensions`) are extra Dockview panels that present Babylon GUI (`createUiSurface`); they are not the UserInterface designer. UserInterface / EditorUtilityInterface **authoring** is last P12 (`p12-ui-editors`). |

## Outliner and Details visuals

- **Outliner** (`TreeView`): `--chrome-row` (28px) rows, type icon from `resolveActorTypeVisual` (Actor color; mesh/light/camera glyphs for engine `Actor` placeholders; user classes use the parent engine icon), selected row `bg-primary/20` + `border-l-primary`. **Search** and **+** share one row. Visibility/lock are compact ghost `IconActionButton`s. Immediate drag-to-parent (`reparentArm: "immediate"`); drop on a row attaches as child. Trailing **⋯** opens Duplicate / Delete (`NestedMenu`). **Double-tap** frames the actor (`frameActor` via viewport context). **+** opens a **Place Actors** `CatalogDialog` (Shapes, Lights, Camera, Empty, Project assets) with the same type icons. Spawned lights create a Babylon `PointLight` / `DirectionalLight` / `SpotLight` (`authoredLight:<actorId>`) with authored `range` / `outerAngle` and dim the default hemi; spawned cameras create a `FreeCamera` (`authoredCamera:<actorId>`) — game cameras become detached `UniversalCamera` in `p-lighting-camera` ([engineplan §2.5](../engineplan.md)); the editor orbit camera stays ArcRotate (`stealActiveCamera: false`). Play currently makes the first authored camera `activeCamera`; the contract is `scene.settings.mainCameraActorId`. Light, camera, and audio actors also use camera-facing billboard icons instead of the cube proxy so they stay pickable (billboards are icons, not the illumination system). Place Actors copies class prefab `SerializedGraph.components` from the open tab **or** the disk class document.
- **Details** (`PropertyGrid`): stacked **title-above-control** rows (`Field` vertical) with compact inspector spacing. Labels are Title Cased (`meshKind` → `Mesh Kind`, `2D camera width` → `2D Camera Width`). Category headers use `--secondary`. Vector axes use `--axis-x/y/z` on one nowrap row under the title (letters live on `NumericDragField`). Scalar number rows keep a compact unlabeled scrub handle so the title is not repeated. Checkboxes are compact (`size-4`) under the title. Reset is a compact icon button (`↺`) on the title line, not the word Reset. Controls use `--chrome-row` (28px). **Add Component** uses the same catalog chrome, grouped Rendering / Camera / Physics. Numeric rows (`NumericDragField`) keep an empty typed draft; emptying does not commit `0` — blur restores the last committed number.
- **Typed component rows** (`apps/editor/src/lib/component-property-rows.ts`): `MeshComponent.assetGuid` / Sprite / Tilemap / Widget / AnimationGraph open `AssetPicker` (button shows the asset name, stores the guid). Sprite/Tilemap `sortingLayer` is an enum from project `twoD.sortingLayers`. `RigidBodyComponent.motionType` is an enum; `gravityScale` / damping use sliders (0–10). `ColliderComponent.shape` flattens to kind plus half-extents / radius (polygon / mesh point clouds are not JSON text); `friction` / `restitution` are 0–1 sliders; `layer` / `mask` are 32-bit `FlagsField` toggles (Layer 0–31). `LightComponent.color` is a native color row; `intensity` is a 0–16 slider; `lightKind` is Point / Spot / Directional; `range` defaults to 10; Spot also shows `outerAngle` (degrees, default 45). Camera FOV (1–179) and orthographic size (0.1–50) are sliders. Camera `projectionMode`, near/far, fog / IBL, and scene **Default Camera** (`SceneComponentPicker` filtered to `CameraComponent`) are [engineplan §2.5](../engineplan.md) / `p-lighting-camera`. Scene **Game Instance** uses `ClassPicker` filtered to GameInstance lineage.
- **Viewport overlay**: toolbar island on `--popover` with a shadow so it separates from the 3D view. Move / Rotate / Scale, **Drag Select**, a **Viewport Settings** `NestedMenu` (Snap, Show Grid, Joystick), and 2D/3D. Gizmo / Drag Select / Focus pressed states use accent fill + primary border. Drag Select hijacks the next one-finger gesture in 2D and 3D (live dashed overlay `viewport-marquee`), then unpresses and keeps the multi-selection. Prefab hides Drag Select. Selecting a camera actor draws a dashed frustum and a 1 fps corner preview (`camera-preview`). Selecting a light actor draws dashed influence (point rings, spot cone, directional arrow).

## 2D specifics

- **Marquee**: hold ~250ms then drag in 2D selects actors whose origin falls inside the rect (`viewport-gestures.ts`, `two-d.ts`). Immediate one-finger drag **pans** 1:1 with the pointer (orthographic frustum over CSS canvas size, so hardware scaling does not change feel). 3D one-finger drag looks the camera instead. **Drag Select** (toolbar) marquees immediately in both modes using the same origin-in-rect test, then turns itself off.
- **Tile grid**: shader plane on XY (2D) or XZ (3D); major lines at `settings.grid.tileSize`, minor lines at `tileSubdivisions`. The plane snaps to the editor camera target and scales with the frustum so it does not cut off (`editor-grid.ts`). `settings.grid.showGrid` toggles it; 2D `cameraBounds2D` stays a separate line overlay.
- **`cameraBounds2D`**: rectangle drawn in the viewport for the game camera frame.
- **`pixelsPerUnit`**: project setting (default 100); drives pixel-perfect ortho bounds and grid snapping.
- **Pixel-perfect sampling**: when `twoD.pixelPerfect` is on in 2D mode, `setPixelPerfect` also runs `applyPixelArtSamplingToScene` (nearest sampling, clamp wrap, anisotropy 1) on every texture currently on the Babylon scene.
- **Integer zoom steps**: project setting (`twoD.integerZoomSteps`, on in the 2D template) does **not** quantize the editor camera. Pinch and wheel stay continuous so 2D zoom tracks the fingers; pixel-perfect still snaps the camera *target* to the pixel grid. `pixelZoom()` is the live scale.
- **Sorting layers**: ordered list in Project Settings (`NamedListEditor`); `(sortingLayer, orderInLayer)` compiled to one `alphaIndex` sort key; rendering groups reserved for coarse background / world / foreground / UI separation (`sorting.ts`).
- **Locked actors**: `isPickable = false` and the viewport gizmo attaches only to pickable meshes. **Locking an actor immediately drops it from `selectedActorIds`** (Outliner lock toggle and Details Locked). Unlock does not reselect. Details then shows scene settings when nothing remains selected.

## Actor Prefab tab

Prefab is a **window of the class document**, not a fourth chrome `DocumentKind`. Default class layout:

| Dock | Panels |
| --- | --- |
| Center group | **Graph** and **Prefab** as siblings (`direction: "within"`). Selecting Prefab fills the workspace like Viewport does on a Scene. |
| Left | **Components** above **Class** (My Blueprint member tree with type-colored rows and trailing section +; Inspector shows the selected member). |
| Right / bottom | Inspector, Compiler Results |

The Prefab viewport reuses `ViewportToolbar` + `createEngine` (unlit gizmos, fly/look camera, settings menu for snap / show-grid / joystick). Drag Select is hidden — Prefab has no actor multi-select. The canvas is full-size, not a 160px sidebar strip, and stays dark like the Scene viewport. Component add/remove/reparent (`parentId`) writes `SerializedGraph.components` through `applyGraphChange` (`graph.setComponents` / `scene.reparentComponent`). Place Actors instantiates those components when spawning a Class asset from an open tab **or** from the class file on disk.

**Focus** (toolbar toggle) closes dock tabs that are not on the Engine Settings Focus keep-list. Class default is Graph only; Scene default is Viewport. Keep-listed tabs stay only if they were already open.

Play instantiates the **open scene tab** (`playSceneFromOpenDocuments` / `resolvePlayScene`). Graphs and Content Browser may stay open; **only one scene document** is open at a time (opening another closes the previous after the Unsaved dialog). **If no scene tab is open, Play is disabled** — it does not fall back to `startupSceneGuid`, `assets/main.scene.babasset`, or demo actors, and there is no Play-side startup-scene loader. `startupSceneGuid` on `project.json` is the packaged / export boot scene (asset guid, so rename is safe; `p14-export` / `apps/player` consume it). Play currently looks through the first `CameraComponent`; [engineplan §2.5](../engineplan.md) / `p-lighting-camera` replaces that with a named **Default Camera** pick and a **Possess Camera** node. No camera keeps the default Play camera. See [physics.md](physics.md) and [render.md](render.md).

See [command-layer.md](command-layer.md) for undo/journal and [gestures.md](../design/gestures.md) for touch contracts.
