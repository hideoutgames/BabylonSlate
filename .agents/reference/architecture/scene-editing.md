# Scene Editing

World Scene documents in the Haptic editor: schema, selection, command path, viewport tools, prefab sync and Simulation capture.

## Ownership

| Area | Source |
| --- | --- |
| Schema, normalization, `ViewportMode`, Euler helpers | [`packages/core/src/scene.ts`](../../../packages/core/src/scene.ts) (`SCENE_SCHEMA_VERSION = 4`) |
| Scene commands, `diffSceneCommands`, `planSceneChange`, journal revivers | [`packages/edit/src/commands/`](../../../packages/edit/src/commands/) |
| Editor camera, gizmos, outline, grid, placement, gestures, 2D sorting, `EditorSceneSync` | [`packages/render/src/`](../../../packages/render/src/) (`editor-camera.ts`, `gizmo-host.ts`, `overlay-transform-box.ts`, `scene-outline-host.ts`, `editor-grid.ts`, `editor-place.ts`, `viewport-gestures.ts`, `two-d.ts`, `sorting.ts`, `editor-scene-sync.ts`) |
| PropertyGrid, TreeView, pickers, PanelFrame | [`packages/editor-kit/src/`](../../../packages/editor-kit/src/) |
| Selection provider, session view state | [`apps/editor/src/context/`](../../../apps/editor/src/context/) (`scene-editing-context.tsx`, `editor-session-state-context.tsx`) |
| Panels, Place Actors, Outliner drops, typed Inspector rows | [`apps/editor/src/panels/`](../../../apps/editor/src/panels/), [`apps/editor/src/lib/`](../../../apps/editor/src/lib/) (`place-actors.ts`, `outliner-drop.ts`, `component-property-rows.ts`) |
| Simulation capture | [`packages/runtime/src/simulation-scene-capture.ts`](../../../packages/runtime/src/simulation-scene-capture.ts), [`component-authoring.ts`](../../../packages/runtime/src/component-authoring.ts) |

## Document invariants

- One world Scene tab at a time; opening another closes the previous (Save / Discard / Cancel). Graphs, Content Browser and SceneLayer tabs stay. Closing the Scene disposes its viewport `Scene`, never the project Engine.
- SceneLayer is a separate 2D overlay document ([scene-layers.md](scene-layers.md)). Scene Streaming places a `SceneStreamingActor`; the editor never realizes the target scene's actors, only an `editorOnly` label.
- Load always runs `normalizeScene`. Additive settings keys never bump `SCENE_SCHEMA_VERSION`; files are not rewritten on load. Old scenes without this step crashed the Inspector.
- Actor ids are unique runtime GUIDs ([object-model.md](object-model.md#guids-and-identity)): `assertUniqueSceneActorIds` rejects duplicates (never renames). Place, Duplicate, Paste and drag-copy mint fresh ids; Add Component allocates an unused actor-local component id.
- Rotation is a quaternion `[x,y,z,w]` on disk; UI shows Euler degrees. Missing component `transform` normalizes to identity.
- Folders (`folders[]`, `actor.folderId`) are editor-only and ignored by runtime. Transform hierarchy is `actor.parentId`; `wouldCreateCycle` refuses self-ancestry.
- Components with `editorOnly: true` are excluded from Play/player rendering.
- Scenes carry no Game Instance; Play/export read `ProjectSettings.gameInstanceClass`.
- A scene never mixes physics worlds (`settings.physicsWorld`). `viewportMode` is authored data (Play camera, 2D materials, navigation), so toggling it dirties the scene.

## Command path

- Every Inspector / Outliner / viewport mutation: `applySceneChange` → `planSceneChange` → undo stack + crash journal ([command-layer.md](command-layer.md)). Nothing bypasses it.
- `diffSceneCommands` must produce a delta for every authored field; anything it cannot express becomes one `scene.replace`. Add a command when adding an authored field.
- Optional settings reset by deleting their key; diffs record removals so inheritance survives Undo/Redo/recovery.
- Gizmo drags coalesce on `transform:{actorId}` / `transforms:{sortedIds}` (one undo per gesture). `commitGizmoTransform` only runs after `onGizmoDragStart`; a drag-less `onDragEnd` must not write TRS (it re-dirtied after Save All).
- `RemoveActorCommand` stores one actor; hierarchy deletes emit one remove per actor.
- `DocumentService.lockAuthoring(reason)` leases authoring writes (Simulation). Setters, commands, Undo/Redo, prefab sync and reloads respect the lock.

## Selection and session state

- `SceneEditingProvider` is the only selection owner; panels consume `useSceneEditing()` and never keep separate selection.
- Locking an actor removes it from `selectedActorIds`; locked actors are unpickable and never get a gizmo.
- `EditorSessionStateProvider` keeps camera poses, graph viewports and similar view state per document id for one project session (non-reactive; moves on `repathed`). Pivot Around Center, shading mode and Show Collisions are session-only, never scene JSON.

## Prefab instance sync

- Place Actors copies the ancestor-merged Class prefab and stamps `sourceId`. Name, actor transform, visible, locked, `parentId`, `folderId` stay instance-owned.
- `overrideKeys` mark instance-owned component fields; `suppressedComponentSourceIds` stops sync resurrecting deleted prefab rows.
- Opening a Scene syncs instances in memory; if that changes it, history is dropped and the Scene is dirty. Closed Scene files are never rewritten in the background. Prefab edits with the Scene open sync through scene commands.
- Prefab is a window of the Class document, not a `DocumentKind`. Its world origin is the Prefab Root, which equals `SerializedActor.transform` once placed.

## Viewport rules

- Camera and gizmo are mode-parametric (`ViewportMode`). 2D is fixed: XY plane, +Y up, +X right, camera at −Z looking +Z, `useRightHandedSystem = false`. 2D Z-Order is the negated `position.z`.
- World Scenes use Babylon Position/Rotation/Scale gizmos on a utility layer (`manipulator: "trs"`). SceneLayer documents and SceneLayerActor prefabs pass `createEngine({ overlayTransformBox: true })`. Never `BoundingBoxGizmo` or a React overlay.
- Gizmo styling is a restyle of Babylon gizmos (constants in `gizmo-host.ts`); do not `setCustomMesh` the uniform-scale handle. `GIZMO_AXIS_COLORS` mirrors CSS `--axis-*` ([theming.md](theming.md)).
- The Engine lives on a hidden canvas; Scene blit and Prefab `present: "rtt"` forward pointers into Engine pick space (`gizmos.forwardPointer`).
- `EditorSceneSync` applies edits incrementally and rebuilds only on visual fingerprint change. Multi-visual actors get a hidden origin pick proxy (`visibility = 0`) with children `editorActor:<id>|<componentId>`; picks walk up to `editorActor:<id>`. Components are not independently movable in the Scene viewport.
- `setMeshAssets` is a no-op for equivalent payloads, because disposal would leave gizmo and outline on a ghost mesh. KTX2 re-encodes swap bytes (`replaceTextureBytes`) without rebuilding.
- The editor never freezes the active-mesh queue; the FrameGraph collects its own objects.
- Loading Scene blocks remounts, shading changes and context recovery, not incremental applies. Every load carries an abort signal; superseded batches cannot write.
- Collider dashes are world-group meshes, not UtilityLayer or UI overlays. The skybox mesh is always unpickable.
- Camera helper geometry is generated from `engine-content/editor-models/camera.blend` by [`create-editor-camera.py`](../../../scripts/blender/create-editor-camera.py) into [`editor-camera-geometry.json`](../../../packages/render/src/editor-camera-geometry.json). Billboards come from [`engine-content/billboards/`](../../../engine-content/billboards/).

## Modes, Play seed and Simulation

- Scene Mode Design / Landscape / Foliage share one scene and history; each has its own DockView layout. Foliage is static thin-instanced geometry (no actors, scripts or bodies). Landscape sculpting edits one `LandscapeSculptSession` and rebuilds once per pointer event.
- Start In Open Scene (Debug menu, default on) seeds the open Scene tab, else `startupSceneGuid`, which Preview never writes. Overlay Play and Preview Build never share an Engine.
- `captureSimulationScene` captures only at an acknowledged quiescent boundary and returns a complete scene or a named failure, never a subset. It rejects streamed/overlay instances, Dynamic Runtime Mesh and ambiguous identities. References use `$sceneValue` tags resolved by `hydrateScenePropertyReferences`.
