# Object model (P3)

Shared surface for the headless runtime object graph (engineplan §5, §16). Implementation lives in `@babylonslate/object-model`. Deterministic harness lives in `@babylonslate/test-kit`.

## Package API (`@babylonslate/object-model`)

| Export | Role |
| --- | --- |
| `BObject` | Base instance: guid, classId, variables, `onCreation` / `onTick` / `onDestroyed` |
| `Actor` | World-placed object with transform and ordered component list |
| `Scene` | Live Play scene `BObject` (`classId` `Scene:{assetGuid}`). `variables.sceneName` is the authored display name; `variables.assetGuid` is the document guid (Get-only); `variables.gravity` is the live world gravity `{ x, y, z }` (Get/Set). Not spawnable. |
| `SceneLayer` | Session overlay instance (`BObject`); not an Actor. Stores `layerBounds` (orange design canvas, default 32×18). |
| `SceneLayerActor` | Overlay actor tagged `sceneLayerId`; same World tick as world actors |
| `ActorComponent` | Attached to an Actor; own tick |
| `GameInstance` | Session singleton. Application: `onCreation` (script `onInit`), `onTick`, `onGameEnd` (script `onEnd`). Scene: `onSceneStartLoading` / `onSceneFinishLoading` / `onFirstSceneLoaded` / `onSceneExit`. `onSceneLoaded` still aliases finish. |
| `World` | Owns GameInstance, actors in spawn order, RNG, deferred destroy, snapshot, `currentScene`. `beginSceneLoad` / `finishSceneLoad` / `exitActiveScene` / `createScene`. `beginSceneLoad` remembers the loading display name so `exitActiveScene` still fires **OnSceneExit** if finish never ran (Play stop while models-ready is deferred). `end()` exits the active or in-flight scene then `onGameEnd`. `loadScene` / scene swap never fire `onGameEnd`. `createActor` / `createComponent` / `createGameInstance` apply inherited variable defaults and interface guids from `ClassRegistry` (caller overrides win). |
| `ClassRegistry` | Inheritance graph, re-parenting, engine bases and components. `ensure` merges session class metadata; `inheritedInterfaces` walks ancestry. `MAX_CLASS_INHERITANCE_DEPTH` (16, including self) blocks `register` / `reparent` past the limit. |
| `TickPhase` / `TICK_PHASES` / `TickClock` | Fixed-dt phases; `physics` filled by `@babylonslate/physics` |
| `ScriptInterface` / `dispatchInterface` | Interface defs and runtime dispatch with pin defaults |
| `ENGINE_BASE_CLASS_IDS` / `ENGINE_COMPONENT_CLASS_IDS` / `ENGINE_BT_BUILTIN_CLASSES` / `isLockedEngineClassId` | Stable string ids for engine types; locked ids cannot be reparented |
| `ENGINE_CLASS_SCRIPT_APIS` / `engineScriptApiFor` | Per-class script catalog: optional variables (incl. `typeClassIds`), functions, events (Get/Set/Call and Add Event). Overlay 2D classes are in the catalog; Animation Graph / BT / nav bake helpers stay ref-only. Mouse events live on `2DButtonComponent`, not SceneLayerActor. |
| `createWorldSnapshot` | Canonical JSON-serializable world state for harness goldens |
| `createDebugInspectSnapshot` | Read-only Play inspector tree (`tickIndex` + Game Instance / actors / components + optional `variableTypes`). Not a harness golden |
| `createActorsFromSerializedScene` | Build unspawned World actors from a `SerializedScene` for Play. Skips `SceneLayerActor` (and subclasses); those belong on overlay documents. |
| `createActorsFromSerializedSceneLayer` | Overlay actors from a `SerializedSceneLayer` (stamped `sceneLayerId`). Drops Skybox / Camera / Light. |

Depends only on `@babylonslate/core` (Guid, Result, math, seeded RNG). No React, Babylon, or Capacitor.

## Tick phases

Order is fixed and named from the first commit:

1. `gameInstance` — GameInstance `onTick`
2. `actors` — Actors in **spawn order**
3. `components` — Each actor’s components in **attach order**
4. `physics` — Backend `step(dt)` + transform write-back (see [physics.md](physics.md))
5. `postPhysics` — Post-physics fixups

Never iterate a `Map` for tick or snapshot order. Spawn and attach use stable arrays.

## Destroy / spawn during tick

Mid-tick `destroy` and `spawn` enqueue work. Deferred queues flush after the current phase (or end of tick) so destroying one actor never skips a sibling in the same phase.

## Snapshot (harness, not bridge)

`createWorldSnapshot(world)` returns a pure JSON-serializable tree with sorted variable keys and spawn/attach order for lists. This is the P3 golden format — **not** the P4 `Float32Array` bridge snapshot layout.

## Inspect snapshot (Play debugger)

`createDebugInspectSnapshot(world)` is a separate, lossy JSON tree for the overlay inspector: Game Instance if any, then actors parent-before-child (`parentId` variable), then each actor’s components as children. Label is `name` else `classId`. Values are JSON-safe (`BObject` → `{ guid, classId }`; circular / non-cloneable → `formatValue()`). Optional `variableTypes` stamps ClassRegistry `inheritedVariables` types onto keys that exist in `variables`; untyped keys are omitted so the editor infers. See [debugger.md](debugger.md).

## RNG

The world owns a seeded PRNG from `createSeededRng` in `@babylonslate/core`. Simulation code must not call `Math.random`.

## Engine components

Registered as typed stubs (asset refs + lifecycle hooks) from day one; `RigidBodyComponent` / `ColliderComponent` / 3D `MeshComponent` collision are synced by `PhysicsWorldSync` in `@babylonslate/runtime`:

`MeshComponent`, `SpriteComponent`, `TilemapComponent`, `CameraComponent`, `LightComponent`, `HemisphericFillLightComponent`, `SkyboxComponent`, `Text3DComponent`, `AudioComponent`, `ParticleComponent`, `RigidBodyComponent`, `ColliderComponent`, `AnimationGraphComponent`, `BehaviourTreeComponent`, `NavAgentComponent`, `NavMeshComponent`, `NavMeshBlockerComponent`, `BlockingVolumeComponent`, overlay-exclusive `2DAnchorComponent`, `2DTextureComponent`, `2DMaterialComponent`, `2DButtonComponent`, `2DTextComponent`, `2DRichTextComponent`, `2DPanelComponent` (`SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS`).

Search and Add Component advertise shipped behaviour: `TilemapComponent` is addable (P10 Play loads chunk meshes and Rapier chains). `BehaviourTreeComponent` and `NavAgentComponent` are addable. `NavMeshComponent`, `NavMeshBlockerComponent`, and `BlockingVolumeComponent` are Place Actors only (not Add Component). `BTTask` / `BTDecorator` / `BTService` / `BTComposite` plus the built-in Wait / MoveTo / … classes are inheritable engine bases. `AudioComponent` is addable and searchable (`audioAssetGuid`, play-on-start, loop, component volume); Play-on-start emits `playSound` with the owning actor as emitter. Compiled graphs call `ctx.playSound` / `ctx.setChannelVolume` / `ctx.setGlobalVolume` (see [audio.md](audio.md)). `SkyboxComponent` is addable and searchable (Place Actors **Environment → Skybox**); `size` default 1000, `faces` six nullable Texture guids (empty = engine default cubemap). It is a scene backdrop mesh, not IBL and not a Content Browser document (see [render.md](render.md) and [engineplan §2.5](../engineplan.md)). `HemisphericFillLightComponent` is addable and searchable (Place Actors **Lights → Hemispheric Fill**); `intensity` default 0.9, `groundColor` black; direction is actor rotation × +Y. Not seeded on new 3D scenes. `Text3DComponent` is addable and searchable (catalog **3D Text**, Place Actors **Environment → 3D Text**, Lucide `TypeIcon`); `text` default `"Text"`, `size` `1`, `color` white, `alignment` `"left"` (`left` / `center` / `right` horizontal anchor, bottom pivot), optional Font `fontAssetGuid` (facetype chunk). Flat triangulated TypeFace mesh, not Development Only (see [fonts.md](fonts.md) and [render.md](render.md)). `ParticleComponent` is addable and searchable (`particleSystemGuid`, play-on-start, sorting layer/order); Play-on-start emits `assignParticle`. Compiled graphs call `ctx.playParticles` / `ctx.stopParticles` (see [particles.md](particles.md)). Add Component also lists **Project** rows that create the matching engine component with the asset guid already set (Model / Mesh → `MeshComponent.assetGuid`, Audio, ParticleSystem, Sprite, Tilemap, AnimationGraph, BehaviourTree). User Class assets whose ancestry includes `ActorComponent` and not `Actor` are addable; NavMesh subclasses stay hidden. There is no `ModelComponent` — imported models bind on `MeshComponent.assetGuid`.

See [physics.md](physics.md) for RigidBody / Collider / Mesh collision property schemas, pairing warnings, collider TRS bake, named collision layers, and backend sync.

### Engine script API

`ENGINE_CLASS_SCRIPT_APIS` in `@babylonslate/object-model` is the Get/Set/Call/Add Event catalog (no React/Babylon). Each class id may list `variables` (`propertyKey` on `component.variables`, optional `typeClassIds` when a pin picker accepts more than one Content Browser type — Mesh `assetGuid` is Mesh **and** Model, optional `getOnly` for Get without Set — Scene **Scene Name** and **Asset Guid**), `functions` (`runtime` name for `ctx.callComponentFunction` or GI `ctx` helpers), and `events` (`eventType` / `exportName`). Overlay pointer events are on `2DButtonComponent` only; SceneLayerActor has no native mouse stubs. Collision events are on `ColliderComponent`. Text components (3D + overlay 2D) expose Set Text and On Text Changed. Audio exposes Play/Stop and On Audio Finished. Camera Possess, RigidBody Add Impulse, and Nav Agent Move To / Stop Movement are Calls off the component pin. Animation Graph, Behaviour Tree, NavMesh, NavMesh Blocker, and Blocking Volume stay **ref-only**. Catalog completeness and Play apply paths: [scripting.md](scripting.md).

`GameInstance` catalog functions are **Get Scene Loading Progress** (`0..1`) and **Get Scene Reference** (`objectRef("Scene")`). Play registers a child type `Scene:{guid}` per library scene so Cast / `isA` walk to engine `Scene`. Scene variables: **Scene Name** and **Asset Guid** (Get-only), **Gravity** (`vec3`, Get/Set — Play applies `setWorldGravity` onto the physics backend). `ctx.getComponentById` on a live current `Scene` searches world actors by authored component id / `sourceId` and returns null when the scene is inactive or the id is missing.

`createActorsFromSerializedScene` (same package) builds unspawned World actors from a `SerializedScene` — ids, actor transforms, and component properties plus each component’s local `transform` / `parentId` — so Play can instantiate the authored document without the editor touching Babylon. Overlay classes (`SceneLayerActor` and subclasses) are skipped here; `createActorsFromSerializedSceneLayer` stamps `sceneLayerId` and strips the overlay denylist (Skybox / Camera / Light).

## ScriptInterface dispatch

- An interface def is a guid plus method signatures (name, input/output pin defaults as plain values).
- `dispatchInterface(target, interfaceGuid, method, args)` invokes a registered handler or returns pin defaults (no-op).
- Classes declare implemented interface guids; handlers are injectable so P5 can bind compiled graphs without changing the dispatch shape (see [scripting.md](scripting.md)).
- `World.createActor` copies `ClassRegistry.inheritedInterfaces` onto the instance unless the caller passes `implementedInterfaces`.
- Play `ScriptHost.callInterface` calls `dispatchInterface` against the world's `InterfaceRegistry` so a missing implementation returns pin defaults instead of `undefined`.
- `ScriptHost.invokeEvent(classId, event, self?, args?, componentId?)` and compiled `ctx.invokeCustomEvent(target, eventName, args)` pass `args` into the entry as `ctx.commandArgs` (alias `ctx.args`). Cross-instance Call dispatches on `target.classId` with `self = target`. `ctx.invokeFunction(target, functionName, args)` looks up `exports[functionName]` on `target.classId` (function graphs have no lifecycle `point.event`) and returns the result or `{}`, or a Promise of that object when the export is async. `ctx.getComponentById` matches `guid` or authored `sourceId` on an Actor, or searches current-world actors when the target is the live `Scene`. See [scripting.md](scripting.md).

## Re-parenting

`ClassRegistry.reparent(classId, newParentId)`:

- Rejects cycles.
- Rejects engine locked ids (`isLockedEngineClassId`: bases, engine components, BT builtins).
- Returns an invalidation list of inherited members that break under the new parent.
- Prefab Root Details exposes **Parent Class** (Actor ancestry only). Commit is `ClassRegistry.reparent` then `saveDocument(..., { parentClass })` — header only; graph members, overrides, and components are not rewritten. Cycles, self, depth, locked engine classes, and leaving Actor ancestry reject without a write. Class panel change-parent UI is still later polish.
- `ensure(def)` registers a user class or merges variables / interface guids onto an existing user class. `RuntimeDriver.loadScripts` uses this so Play spawn can apply class metadata. `ensure` does not rewrite `parentClassId` on an already-registered def.

## Deterministic harness (`@babylonslate/test-kit`)

| Export | Role |
| --- | --- |
| `runDeterministicScenario` | Seed RNG, fixed dt, N in-process ticks, return canonical snapshot |
| `installHarnessProjectFixtures` | Memory VFS + minimal project/asset JSON stubs |

Acceptance: a 120-tick scenario reproduces a committed golden byte-exactly and is identical across two runs with the same seed.

Worker / SAB comparison lands in P4 via `@babylonslate/bridge` and `@babylonslate/test-kit` multi-transport harness (see [bridge.md](bridge.md)).
