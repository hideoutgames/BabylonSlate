# Object model (P3)

Shared surface for the headless runtime object graph (engineplan §5, §16). Implementation lives in `@babylonslate/object-model`. Deterministic harness lives in `@babylonslate/test-kit`.

## Deformer Component

- `DeformerComponent` targets one `MeshComponent` on its own actor by `targetMeshComponentId`; both primitive meshes and imported models are eligible. Exact component IDs take precedence over inherited source IDs. The first enabled cage per target wins; disabled cages do not reserve a target. It is unavailable in SceneLayers.
- Enabled defaults off. `strength` clamps to 0–1; `resolution` is a tuple of 2–4 integer controls per axis (64 maximum). `offsets` stores XYZ offsets in target-local units, with control index `x + resolutionX * (y + resolutionY * z)`. Missing/nonfinite offsets become zero. Changing resolution resets offsets. `fitToMesh` defaults true; manual `boundsMin`/`boundsMax` default to −0.5/+0.5 and require a positive span on each axis.
- Graph Get/Set exposes these properties. **Set Control Point Offset** accepts a control index and Vector 3, returning false for an invalid index/offset or unavailable target. **Reset Control Points** clears offsets. Both calls target the component; they do not redirect to an actor or sibling.
- The worker sends revisioned `setActorDeformers` control snapshots, coalesces tick edits per actor and omits unchanged snapshots. It never sends or scans mesh vertices. Disabling the last cage sends an empty snapshot. Slot retirement discards retained state.
- Serialized offset and bound coordinates clamp to ±10¹⁰ before Float32 upload, matching dynamic geometry's envelope. Set Control Point Offset rejects values outside that envelope.
- Deformation follows model animation and material World Position Offset in the renderer. This is visual geometry: physics, navigation and CPU picking keep the original shape. GPU cost scales with affected vertices and rendering passes; the control limit is not a device performance guarantee.

## Package API (`@babylonslate/object-model`)

| Export | Role |
| --- | --- |
| `BObject` | Base instance: guid, classId, variables, `onCreation` / `onTick` / `onDestroyed` |
| `Actor` | World-placed object with transform and ordered component list |
| `Scene` | Live Play scene `BObject` (`classId` `Scene:{assetGuid}`). `variables.sceneName` is the authored display name; `variables.assetGuid` is the document guid (Get-only); `variables.gravity` is the live world gravity `{ x, y, z }` (Get/Set). Not spawnable. |
| `SceneLayer` | Session overlay instance (`BObject`); not an Actor. Stores `layerBounds` (orange design canvas, default 32×18). |
| `SceneLayerActor` | Overlay actor tagged `sceneLayerId`; same World tick as world actors |
| `ActorComponent` | Attached script instance with independent variables/interfaces; Begin Play after owner spawn, own Tick, Destroyed on owner destruction or Play stop. |
| `GameInstance` | Session singleton. Application: `onCreation` (script `onInit`), `onTick`, `onGameEnd` (script `onEnd`). Scene: `onSceneStartLoading` / `onSceneFinishLoading` / `onFirstSceneLoaded` / `onSceneExit`. |
| `Subsystem` | Hidden abstract engine base (`BObject`) of both subsystem kinds. Never offered in pickers and never instantiated. End runs at most once: `ended` is true from the moment End starts, `destroyed` once it returns. See [Subsystems](#subsystems). |
| `GameSubsystem` | Session-lifetime subsystem with Game Instance parity hooks: `onCreation` (On Init), `onTick`, `onGameEnd` (On End), and the four scene hooks. It is not a `GameInstance` (Cast to GameInstance fails). |
| `SceneSubsystem` | Lives with one main `Scene` (`scene`). Hooks: `onCreation` (On Init), `onTick`, `onEnd`, plus Scene Loaded, Streamed Scene Loaded / Unloaded, Scene Layer Added / Removed and Scene Actor Spawned / Destroyed. Notifications stop once it has ended. |
| `World` | Owns GameInstance, subsystems, actors in spawn order, RNG, deferred destroy, snapshot, `currentScene`. `beginSceneLoad` / `finishSceneLoad` / `exitActiveScene` / `createScene`. `beginSceneLoad` remembers the loading display name so `exitActiveScene` still fires **OnSceneExit** if finish never ran (Play stop while models-ready is deferred). `end()` exits the active or in-flight scene then `onGameEnd`. `loadScene` / scene swap never fire `onGameEnd`. `createActor` / `createComponent` / `createGameInstance` / `createGameSubsystem` apply inherited variable defaults and interface guids from `ClassRegistry` (caller overrides win). Subsystem API: `setGameSubsystems` (before `start()` only; throws after), `setSceneSubsystemClasses`, `getGameSubsystems` / `getSceneSubsystems`, `findSubsystems(classId)`, `notifyStreamedSceneLoaded` / `notifyStreamedSceneUnloaded`, `notifyActorEnteringPlay`. |
| `ClassRegistry` | Inheritance graph, re-parenting, engine bases and components. `ensure` merges session class metadata; `inheritedInterfaces` walks ancestry. `classIds()` lists every registered id in registration order (engine defaults first). `MAX_CLASS_INHERITANCE_DEPTH` (16, including self) blocks `register` / `reparent` past the limit. |
| `TickPhase` / `TICK_PHASES` / `TickClock` | Fixed-dt phases; `physics` filled by `@babylonslate/physics` |
| `ScriptInterface` / `dispatchInterface` | Interface defs and runtime dispatch with pin defaults |
| `ENGINE_BASE_CLASS_IDS` / `ENGINE_COMPONENT_CLASS_IDS` / `ENGINE_BT_BUILTIN_CLASSES` / `isLockedEngineClassId` | Stable string ids for engine types; locked ids cannot be reparented. Includes `Subsystem` / `GameSubsystem` / `SceneSubsystem` (`SUBSYSTEM_CLASS_ID` and peers; all kind `object`). `HIDDEN_ENGINE_BASE_CLASS_IDS` / `isHiddenEngineBaseClassId` mark `Subsystem`: known to validation, never offered in parent, Class Type or Cast pickers. |
| Subsystem helpers (`subsystems.ts`) | `subsystemBaseClassIdOf`, `instantiableSubsystemClassIds` (leaf classes), `subsystemClassIdsForGet`, `compareClassIds` (code-unit order), `gameSubsystemGuid` / `sceneSubsystemGuid`. They take any `{ ancestry(classId) }` view, so the runtime `ClassRegistry`, editor parent lookups and the exporter share them. |
| `ENGINE_CLASS_SCRIPT_APIS` / `engineScriptApiFor` / `engineNativeEventsFor` | Per-class script catalog: optional variables (incl. `typeClassIds`), functions, component-bound events, and Self lifecycle `nativeEvents` (Get/Set/Call and Add Event). Overlay 2D classes are in the catalog; Animation Graph / BT / nav bake helpers stay ref-only. Mouse events live on `2DButtonComponent`, not SceneLayerActor. |
| `createWorldSnapshot` | Canonical JSON-serializable world state for harness goldens |
| `createDebugInspectSnapshot` | Read-only Play inspector tree (`tickIndex` + Game Instance / subsystems / actors / components + optional `variableTypes`). Not a harness golden |
| `createActorFromSerialized` | Build one unspawned World actor from a scene or SceneLayer document row for Play. Skips `SceneLayerActor` (and subclasses) unless given a `sceneLayerId`; overlay actors are stamped with it and drop SceneLayer-denied components. |

Depends only on `@babylonslate/core` (Guid, Result, math, seeded RNG). No React, Babylon, or Capacitor.

## Tick phases

Order is fixed and named from the first commit:

1. `gameInstance` — GameInstance `onTick`, then live GameSubsystems in class-id order
2. `sceneSubsystems` — The main Scene's live SceneSubsystems in class-id order; gated like actors (`canTickScene`, then `canTickSceneSubsystem`)
3. `actors` — Actors in **spawn order**
4. `components` — Each actor’s components in **attach order**
5. `physics` — Backend `step(dt)` + transform write-back (see [physics.md](physics.md))
6. `postPhysics` — Phase boundary after the physics write-back (`onPhase` timing, deferred flush); no built-in work

Never iterate a `Map` for tick or snapshot order. Spawn and attach use stable arrays; subsystem lists are sorted by class id.

`WorldOptions.componentHooksFor` binds script lifecycle hooks to both serialized and dynamically created components. Component creation is deferred until its owner enters the world, runs once, and is skipped for cancelled preparation. In Play, component callbacks use the owning Scene or SceneLayer readiness gate: Begin Play waits for its valid presented frame, retained ready layers continue ticking, and cancelled components never run Begin Play or Destroyed. Adding a component to a ready live Actor begins it immediately. ActorComponent subclasses expose Begin Play, Tick, and Destroyed in Class graphs; Self is the attached component itself.

`WorldOptions.canTickScene` can suspend the SceneSubsystem, actor, component, physics and post-physics phases during cooperative scene preparation while Game Instance and GameSubsystems continue ticking. It is rechecked after Game Instance and between subsystems/actors/components, so a scene switch initiated during the tick stops the remaining incomplete scene work immediately. `createActorFromSerialized` builds one unspawned actor per document row, so preparation can yield between rows.

`WorldOptions.canTickActor` adds an independent owner gate for world actors and each SceneLayer. The World rechecks it between actor and component callbacks, so a newly blocked owner cannot continue the same tick while another ready layer remains active. It does not defer structural spawning or replace the driver's separate physics and authored creation-callback readiness policy.

## Subsystems

Engine-managed singletons: a user Class opts in by parenting to `GameSubsystem` (session lifetime) or `SceneSubsystem` (main-Scene lifetime). There is no registration list; overlay Play, Preview Build and exported games create every leaf class automatically.

- **Leaf-only instancing.** `instantiableSubsystemClassIds` returns user classes of a subsystem lineage that no other user subsystem class extends. A base with a subsystem subclass is never created itself.
- **Order.** Class-id code-unit order (`compareClassIds`), never locale or `Map` order.
- **Identity.** Fixed guids, never drawn from the World `guidFactory`, so actor guids do not shift: `subsystem:<classId>` for a GameSubsystem, `scene-subsystem:<classId>:<n>` for a SceneSubsystem (`n` counts main-Scene creations this session). Class variable defaults and inherited interfaces apply as for actors.
- **Kind.** The class kind stays `object` (no new `ClassKind`). Lineage is gated by `isA`, and subsystem classes never spawn as actors.
- **Ended vs destroyed.** `ended` flips when End starts, so Get, ticks and notifications skip the instance. `destroyed` flips when End returns, so On End can still call its own functions.
- **Lookup.** `findSubsystems(classId)` returns live instances whose class isA `classId`: GameSubsystems, then the current main Scene's SceneSubsystems, each in class-id order. The first entry is the Get result; more than one is ambiguous.

### Lifecycle order

| Moment | Order |
| --- | --- |
| `start()` | GameSubsystems On Init, then the Game Instance On Init |
| Scene Start / Finish Loading, First Scene Loaded, Scene Exit | Game Instance first, then GameSubsystems |
| `finishSceneLoad` | After those hooks, the main Scene's SceneSubsystems hear On Scene Loaded. A handler that loads another scene re-entrantly stops the rest; First Scene Loaded still reaches every GameSubsystem |
| Tick | Game Instance and GameSubsystems (`gameInstance`), then SceneSubsystems (`sceneSubsystems`) |
| `createScene` (main Scene) | Scene `onCreation`; every SceneSubsystem is constructed and installed (Get finds it); each runs On Init in order, before the Scene's actors spawn (SceneLayer actors are separate) |
| `clearCurrentScene` (every exit path) | SceneSubsystems On End in reverse order while the Scene is still current; then the Scene's `onDestroyed`; then On Scene Exit for the Game Instance and GameSubsystems |
| `end()` | Scene exit, Game Instance On End, then GameSubsystems On End in reverse order |

- `setGameSubsystems` throws after `start()`, which keeps GameSubsystem On Init ahead of the Game Instance's.
- Every main `createScene` builds fresh SceneSubsystems, including a same-scene reload. Streamed sub-scenes and SceneLayers never create them.
- `clearCurrentScene` is the one path every exit shares: scene change, failed realization, `end()`, and direct `createScene` replacement. It and `createScene` tolerate a scene change started from a SceneSubsystem's On End, so no Scene or subsystem is left without End.

### Scene notifications

- **Scene Actor Spawned** fires at spawn commit, immediately before the actor's `onCreation`, for world actors only (not SceneLayer overlay actors). A host that holds `onCreation` back reports an actor committed before the current SceneSubsystems existed with `notifyActorEnteringPlay`, once, as it enters play.
- **Scene Actor Destroyed** fires after the actor is unlinked, before its own teardown.
- **Scene Layer Added** fires after the layer's `onCreation`. **Scene Layer Removed** fires after it is unlinked, before its actors are destroyed.
- **Pairing.** Destroyed and Removed fire only for objects whose Spawned or Added reached the same SceneSubsystem generation, so pre-existing actors (unless reported entering play) and global layers are never reported. Nothing fires after End.
- **Streamed Scene Loaded / Unloaded** come from the host through `notifyStreamedSceneLoaded` / `notifyStreamedSceneUnloaded`.
- The World calls `WorldOptions.sceneSubsystemHooksFor` hooks synchronously. A host that defers script dispatch until scene readiness must keep their order. Runtime readiness, admission and silent teardown are in [scripting.md](scripting.md#subsystems).

## Destroy / spawn during tick

Mid-tick `destroy` and `spawn` enqueue work. Deferred queues flush after the current phase (or end of tick) so destroying one actor never skips a sibling in the same phase.

`World.findActor` uses an incrementally maintained GUID index, so navigation and contact dispatch lookups do not scan the actor array. The index changes when spawn/destroy commits, before lifecycle callbacks; queued spawns remain invisible and queued destroys remain visible until then. Temporary duplicate GUIDs resolve to the first actor in spawn order. Tick/snapshot iteration still uses the ordered array, and removing actors still maintains dense spawn indices.

Preparation rollback uses `World.destroyActorInstance` to target the owned object rather than a reusable guid. An actor cancelled before spawn is removed from the pending queue without firing creation/destruction hooks; an already spawned actor follows normal deferred destruction. Repeated cleanup cannot destroy a later actor with the same guid. SceneLayer destruction removes the owned layer from the live registry before its destruction hooks and removes actors by identity, protecting layers/actors created reentrantly by those hooks.

## Snapshot (harness, not bridge)

`createWorldSnapshot(world)` returns a pure JSON-serializable tree with sorted variable keys and spawn/attach order for lists. This is the P3 golden format — **not** the P4 `Float32Array` bridge snapshot layout.

`WorldSnapshot.subsystems` (`WorldSnapshotObject[]`: guid, classId, variables) lists GameSubsystems, then the main Scene's SceneSubsystems, between `gameInstance` and `actors`. The key is omitted when there are none, so subsystem-free goldens stay byte-identical.

## Inspect snapshot (Play debugger)

`createDebugInspectSnapshot(world)` is a separate, lossy JSON tree for the overlay inspector: Game Instance if any, then subsystems (kind `"subsystem"`, `parentId: null`; GameSubsystems, then SceneSubsystems), then actors parent-before-child (`parentId` variable), then each actor’s components as children. Label is `name` else `classId`. Values are JSON-safe (`BObject` → `{ guid, classId }`; circular / non-cloneable → `formatValue()`). Optional `variableTypes` stamps ClassRegistry `inheritedVariables` types onto keys that exist in `variables`; untyped keys are omitted so the editor infers. See [debugger.md](debugger.md).

## RNG

The world owns a seeded PRNG from `createSeededRng` in `@babylonslate/core`. Simulation code must not call `Math.random`.

## Engine components

`MovementComponent` is a world-only ActorComponent, available through **Add Component → General → Movement** and search. Its settings persist through the normal scene/Class component properties; `parseMovementProperties` supplies shared defaults and sanitizes editor, loaded and scripted values. The runtime owns its upright capsule and publishes Get-only Velocity, Speed, Is Grounded, Is In Air and Is Moving. Its functions and component-bound events are reflected through `ENGINE_CLASS_SCRIPT_APIS`; see [Movement](physics.md#movement-component).

Registered as typed stubs (asset refs + lifecycle hooks) from day one; `RigidBodyComponent` / `ColliderComponent` / 3D `MeshComponent` collision are synced by `PhysicsWorldSync` in `@babylonslate/runtime`:

`MeshComponent`, `SpriteComponent`, `TilemapComponent`, `CameraComponent`, `SpringArmComponent`, `LightComponent`, `HemisphericFillLightComponent`, `SkyboxComponent`, `Text3DComponent`, `AudioComponent`, `ParticleComponent`, `RigidBodyComponent`, `ColliderComponent`, `AnimationGraphComponent`, `BehaviourTreeComponent`, `NavAgentComponent`, `NavMeshComponent`, `NavMeshBlockerComponent`, `BlockingVolumeComponent`, overlay-exclusive `2DAnchorComponent`, `2DTextureComponent`, `2DMaterialComponent`, `2DButtonComponent`, `2DTextComponent`, `2DRichTextComponent`, `2DPanelComponent` (`SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS`).

- Component placement (`world`, `overlay`, or `any`) is declared once in `ENGINE_COMPONENT_DESCRIPTORS` from `@babylonslate/core`; SceneLayer denied/exclusive lists and object-model ids derive from it, with Landscape, Foliage, and Cable consistently world-only.

Search and Add Component advertise shipped behaviour: `TilemapComponent` is addable (P10 Play loads chunk meshes and Rapier chains). `BehaviourTreeComponent` and `NavAgentComponent` are addable. `NavMeshComponent`, `NavMeshBlockerComponent`, and `BlockingVolumeComponent` are Place Actors only (not Add Component). `BTTask` / `BTDecorator` / `BTService` / `BTComposite` plus the built-in Wait / MoveTo / … classes are inheritable engine bases. `AudioComponent` is addable and searchable (`audioAssetGuid`, play-on-start, loop, component volume); Play-on-start emits `playSound` with the owning actor as emitter. Compiled graphs call `ctx.playSound` / `ctx.setChannelVolume` / `ctx.setGlobalVolume` (see [audio.md](audio.md)). `SkyboxComponent` is addable and searchable (Place Actors **Environment → Skybox**); `size` default 1000, `faces` six nullable Texture guids (empty = engine default cubemap). It is a scene backdrop mesh, not IBL and not a Content Browser document (see [render.md](render.md) and [engineplan §2.5](../engineplan.md)). `HemisphericFillLightComponent` is addable and searchable (Place Actors **Lights → Hemispheric Fill**); `intensity` default 0.9, `groundColor` black; direction is actor rotation × +Y. Not seeded on new 3D scenes. `Text3DComponent` is addable and searchable (catalog **3D Text**, Place Actors **Environment → 3D Text**, Lucide `TypeIcon`); `text` default `"Text"`, `size` `1`, `color` white, `alignment` `"left"` (`left` / `center` / `right` horizontal anchor, bottom pivot), optional Font `fontAssetGuid` (facetype chunk). Flat triangulated TypeFace mesh, not Development Only (see [fonts.md](fonts.md) and [render.md](render.md)). `ParticleComponent` is addable and searchable (`particleSystemGuid`, play-on-start, sorting layer/order); Play-on-start emits `assignParticle`. Compiled graphs call `ctx.playParticles` / `ctx.stopParticles` (see [particles.md](particles.md)). `SpringArmComponent` is addable and searchable (catalog **Camera → Spring Arm**, Lucide `SplineIcon`, world scenes only): `armLength` default 4 (0–1000), `enableLocationLag` / `enableRotationLag` default off, `locationLagSpeed` / `rotationLagSpeed` default 10 (0.1–100), `maxLocationLagDistance` default 0 (unlimited), `drawDebugLag` default off. Child components attach at the socket `[0, 0, -armLength]` in the arm's local space, so rotating the arm swings its children and an unrotated child camera looks at the arm origin (see [render.md](render.md#spring-arm)). Add Component also lists **Project** rows that create the matching engine component with the asset guid already set (Model / Mesh → `MeshComponent.assetGuid`, Audio, ParticleSystem, Sprite, Tilemap, AnimationGraph, BehaviourTree). User Class assets whose ancestry includes `ActorComponent` and not `Actor` are addable; NavMesh subclasses stay hidden. There is no `ModelComponent` — imported models bind on `MeshComponent.assetGuid`.

See [physics.md](physics.md) for RigidBody / Collider / Mesh collision property schemas, pairing warnings, collider TRS bake, named collision layers, and backend sync.

`CableComponent` is a world-only `ActorComponent`, available through **Add Component → Physics → Cable**, search, and **Place Actors → Environment → Cable**. The compact Details controls author length, segments, tube width/sides, material and tiling, endpoint pins, solver budgets, forces, damping, optional scene collision and sleeping. Collision defaults off. The default 4-unit cable has 16 segments and an end offset of `[3, 0, 0]`.

**Target Actor** defaults to Self; without a Target Component, **End Position** is local to the cable. Selecting another actor uses its origin, while **Target Component** selects a component on that actor or on Self.

- Picking a Target Actor or Target Component (Details, the Pick Target Actor dialog, or the Class Inspector) resets End Position to `[0, 0, 0]`, so the end attaches at the new target's origin.
- Returning to the cable's own origin (Self with no component) from a zero offset restores the default `[3, 0, 0]`, so the cable keeps its length. A non-zero authored offset is kept.
- Cables gently simulate in scene and Class viewports without collision; Enable Collision applies during Play. In the Class viewport a local Target Component attaches the end to that component.

Class authoring supports local component targets; scene actor targets are chosen after placing the Class. Runtime attachment resolves both component IDs and prefab source IDs. Duplicating actors remaps local and selected attachments to the copied components while retaining external targets. Cable Materials are included in scene/Class dependency collection and Play content loading. Simulation and rendering are described in [render.md](render.md).

`SplineComponent` is a world-scene ActorComponent with local `points` (`[x,y,z][]`, 2–128 points), `curvature` (0–1, default 1) and `closed` (default false; requires at least three points). `parseSplineProperties` sanitizes serialized values and supplies two default endpoints. Scene/Class serialization, inheritance and runtime instantiation retain its data through the standard component paths. The curve and editing handles are editor helpers; it has no native scripting functions or generated gameplay geometry. See [Spline authoring](render.md#spline).

### Engine script API

`ENGINE_CLASS_SCRIPT_APIS` in `@babylonslate/object-model` is the Get/Set/Call/Add Event catalog (no React/Babylon). Each class id may list `variables` (`propertyKey` on `component.variables`, optional `typeClassIds` when a pin picker accepts more than one Content Browser type — Mesh `assetGuid` is Mesh **and** Model, optional `getOnly` for Get without Set — Scene **Scene Name** and **Asset Guid**), `functions` (`runtime` name for `ctx.callComponentFunction` or GI `ctx` helpers), `events` (`eventType` / `exportName`), and `nativeEvents`. `events` are component-bound (Add Event on an attached component) and feed `engineEventTypeClassIds`. `nativeEvents` are Self lifecycle events of a class lineage and never feed that map, so an unbound Init or Tick is not `event.missing_component`. `engineNativeEventsFor(ancestry)` returns the set of the nearest engine class that declares one; the editor's Add Event lists and lineage validation use it. Overlay pointer events are on `2DButtonComponent` only; SceneLayerActor has no native mouse stubs. Collision events are on `ColliderComponent`. Text components (3D + overlay 2D) expose Set Text and On Text Changed. Audio exposes Play/Stop and On Audio Finished. Camera Possess, RigidBody Add Impulse, and Nav Agent Move To / Stop Movement are Calls off the component pin. Animation Graph, Behaviour Tree, NavMesh, NavMesh Blocker, and Blocking Volume stay **ref-only**. Catalog completeness and Play apply paths: [scripting.md](scripting.md).

`GameInstance` catalog functions are **Get Scene Loading Progress** (`0..1`) and **Get Scene Reference** (`objectRef("Scene")`). Native events: GameInstance and GameSubsystem share On Init, Tick, On End, Scalability Changed, On First Scene Loaded, On Scene Start / Finish Loading and On Scene Exit. SceneSubsystem declares On Init, Tick, On End and its seven scene events ([scripting.md](scripting.md#subsystems)). The subsystem entries have no catalog `functions`, which would add Call rows to every host; their graphs reach the two getters through the lineage-gated `gameInstance.*` nodes instead. Play registers a child type `Scene:{guid}` per library scene so Cast / `isA` walk to engine `Scene`. Scene variables: **Scene Name** and **Asset Guid** (Get-only), **Gravity** (`vec3`, Get/Set — Play applies `setWorldGravity` onto the physics backend). `ctx.getComponentById` on a live current `Scene` searches world actors by authored component id / `sourceId` and returns null when the scene is inactive or the id is missing.

`createActorFromSerialized` (same package) builds one unspawned World actor per document row — id, actor transform, and component properties plus each component’s local `transform` / `parentId` — so Play can instantiate the authored document without the editor touching Babylon, yielding between rows. Without a `sceneLayerId`, overlay classes (`SceneLayerActor` and subclasses) are skipped; with one, the actor is stamped with `sceneLayerId` and the SceneLayer denylist ([scene-layers.md](scene-layers.md)) is stripped.

## ScriptInterface dispatch

- An interface def is a guid plus method signatures (name, input/output pin defaults as plain values).
- `dispatchInterface(target, interfaceGuid, method, args)` invokes a registered handler or returns pin defaults (no-op).
- Classes declare implemented interface guids; handlers are injectable so P5 can bind compiled graphs without changing the dispatch shape (see [scripting.md](scripting.md)).
- `World.createActor` copies `ClassRegistry.inheritedInterfaces` onto the instance unless the caller passes `implementedInterfaces`.
- Play `ScriptHost.callInterface` calls `dispatchInterface` against the world's `InterfaceRegistry` so a missing implementation returns pin defaults instead of `undefined`.
- `ScriptHost.invokeEvent(classId, event, self?, args?, componentId?)` and compiled `ctx.invokeCustomEvent(target, eventName, args)` pass `args` into the entry as `ctx.commandArgs` (alias `ctx.args`). Cross-instance Call dispatches on `target.classId` with `self = target`. `ctx.invokeFunction(target, functionName, args)` looks up `exports[functionName]` on `target.classId`, else its nearest user ancestor that exports it (function graphs have no lifecycle `point.event`) and returns the result or `{}`, or a Promise of that object when the export is async. `ctx.getComponentById` matches `guid` or authored `sourceId` on an Actor, or searches current-world actors when the target is the live `Scene`. See [scripting.md](scripting.md).

## Re-parenting

`ClassRegistry.reparent(classId, newParentId)`:

- Rejects cycles.
- Rejects engine locked ids (`isLockedEngineClassId`: bases, engine components, BT builtins).
- Returns an invalidation list of inherited members that break under the new parent.
- Prefab Root Details exposes **Parent Class** (Actor ancestry only). Commit is `ClassRegistry.reparent` then `saveDocument(..., { parentClass })` — header only; graph members, overrides, and components are not rewritten. Cycles, self, depth, locked engine classes, and leaving Actor ancestry reject without a write. Class panel change-parent UI is still later polish.
- `ensure(def)` registers a user class or merges variables / interface guids onto an existing user class. `RuntimeDriver.loadScripts` uses this so Play spawn can apply class metadata. `ensure` does not rewrite `parentClassId` on an already-registered def.
- `RuntimeDriver.loadScripts` registers user parents before their children within one call, so a child no longer falls back to `Actor` because its parent's script came later. A class registered before its script (the built-in demo `Enemy : Actor`) is reparented to the registered parent its script names. Cycles and unknown parents still fall back to `Actor`. A parent arriving in a later `loadScripts` call does not repair earlier children; real hosts load once.
- After registration, `loadScripts` applies the Game Instance's class variable defaults (existing values win), inherited interfaces and interface handlers, then installs subsystems. The Game Instance object exists before scripts load, so this is what makes `createGameInstance`-style defaults hold in Play, Preview Build and the player; all of it runs before `World.start()`.

## Deterministic harness (`@babylonslate/test-kit`)

| Export | Role |
| --- | --- |
| `runDeterministicScenario` | Seed RNG, fixed dt, N in-process ticks, return canonical snapshot |

Acceptance: a 120-tick scenario reproduces a committed golden byte-exactly and is identical across two runs with the same seed.

Worker / SAB comparison lands in P4 via `@babylonslate/bridge` and `@babylonslate/test-kit` multi-transport harness (see [bridge.md](bridge.md)).
