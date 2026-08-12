# Scene editing (P6)

Shared-surface design note for viewport, outliner, details, and the edit layer. Authoritative schema: `packages/core/src/scene.ts` (`SCENE_SCHEMA_VERSION = 2`).

## SerializedScene v2

| Field | Role |
| --- | --- |
| `name` | Scene display name |
| `viewportMode` | `"3d"` \| `"2d"` — per-scene default; toolbar toggle always available |
| `settings` | Environment, gravity, timestep, `gameInstanceClass`, grid, `cameraBounds2D` |
| `actors` | Flat list with `parentId`; hierarchy resolved at apply time |

Each **actor**: `id`, `name`, `classId`, `parentId`, `transform` (position / quaternion rotation / scale), `visible`, `locked`, `components[]`.

Each **component**: `id`, `classId`, `properties` (typed per class in the object-model registry).

**Scene settings** include `grid` (`snapEnabled`, translate/rotate/scale snap, `tileSize`, `tileSubdivisions`) and `cameraBounds2D` (`width`, `height`) for the 2D game-camera frame overlay.

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
| `3d` | ArcRotate orbit/pan/zoom | Full translate / rotate / scale |
| `2d` | Orthographic; pan + pinch zoom only (orbit no-op) | XY translate, Z rotate, XY scale; unused axes hidden |

**2D convention** (fixed, left-handed Babylon): content on the **XY plane**, **+Y up**, **+X right**, editor camera at **−Z** looking toward **+Z**. `scene.useRightHandedSystem` stays `false`.

Implementation: `editor-camera.ts`, `gizmo-host.ts` in `@babylonslate/render`.

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
| `@babylonslate/editor-kit` | Property grid, tree view, panel frame, toolbar, asset picker |
| `apps/editor` | Viewport, Outliner, Details, Mini Asset Browser, Actor prefab tab; `applySceneChange` |

## 2D specifics

- **Marquee**: one-finger drag in 2D selects actors whose origin falls inside the rect (`viewport-gestures.ts`, `two-d.ts`); 3D single-finger drag has no marquee.
- **Tile grid**: major lines at `settings.grid.tileSize`; minor lines at `tileSubdivisions` between majors (`editor-grid.ts`).
- **`cameraBounds2D`**: rectangle drawn in the viewport for the game camera frame.
- **`pixelsPerUnit`**: project setting (default 100); drives pixel-perfect ortho bounds and grid snapping.
- **Pixel-perfect sampling**: when `twoD.pixelPerfect` is on in 2D mode, `setPixelPerfect` also runs `applyPixelArtSamplingToScene` (nearest sampling, clamp wrap, anisotropy 1) on every texture currently on the Babylon scene.
- **Sorting layers**: ordered list in project settings; `(sortingLayer, orderInLayer)` compiled to one `alphaIndex` sort key; rendering groups reserved for coarse background / world / foreground / UI separation (`sorting.ts`).
- **Locked actors**: `isPickable = false` and the viewport gizmo attaches only to pickable meshes, so a locked selection cannot be transformed.

## Actor Prefab tab

The Prefab panel on class documents is **preview-only** in P6: component add/remove updates a local tree and 3D preview, but does not write the class document or the command layer. Persistence is tracked as a P6 deferral in [issue-tracker.md](../agents/issue-tracker.md).

See [command-layer.md](command-layer.md) for undo/journal and [gestures.md](../design/gestures.md) for touch contracts.
