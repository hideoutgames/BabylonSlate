# Object model (P3)

Shared surface for the headless runtime object graph (engineplan §5, §16). Implementation lives in `@babylonslate/object-model`. Deterministic harness lives in `@babylonslate/test-kit`.

## Package API (`@babylonslate/object-model`)

| Export | Role |
| --- | --- |
| `BObject` | Base instance: guid, classId, variables, `onCreation` / `onTick` / `onDestroyed` |
| `UserInterface` | Viewport-layer HUD instance (`assetGuid`, `widgets[]`). Not an Actor. Class id `UserInterface:<assetGuid>`. |
| `Widget` | Authored control scoped to an owning `UserInterface` (`widgetId`, `owner`). Concrete subclasses match schema v3 kinds (`CanvasWidget`, `RectangleWidget`, `StackPanelWidget`, `GridWidget`, `ScrollViewerWidget`, `EllipseWidget`, `ContainerWidget`, `ButtonWidget`, `TextBlockWidget`, `InputTextWidget`, `SliderWidget`, `CheckboxWidget`, `ImageWidget`, `MaterialWidget`, `ProgressBarWidget`, `TouchJoystickWidget`, `TouchButtonWidget`, `TouchDPadWidget`, `UserInterfaceWidget`). v2 aliases (`HorizontalBoxWidget`, `TextWidget`, …) remain registered so old graphs resolve. |
| `Actor` | World-placed object with transform and ordered component list |
| `ActorComponent` | Attached to an Actor; own tick |
| `GameInstance` | Session singleton: `onGameStart` / `onTick` / `onGameEnd` / `onSceneLoaded` |
| `World` | Owns GameInstance, actors in spawn order, RNG, deferred destroy, snapshot. `createActor` / `createComponent` / `createGameInstance` apply inherited variable defaults and interface guids from `ClassRegistry` (caller overrides win). |
| `ClassRegistry` | Inheritance graph, re-parenting, engine bases and components. `ensure` merges session class metadata; `inheritedInterfaces` walks ancestry. `MAX_CLASS_INHERITANCE_DEPTH` (16, including self) blocks `register` / `reparent` past the limit. |
| `TickPhase` / `TICK_PHASES` / `TickClock` | Fixed-dt phases; `physics` filled by `@babylonslate/physics` |
| `ScriptInterface` / `dispatchInterface` | Interface defs and runtime dispatch with pin defaults |
| `ENGINE_BASE_CLASS_IDS` / `ENGINE_COMPONENT_CLASS_IDS` / `ENGINE_WIDGET_CLASS_IDS` / `ENGINE_BT_BUILTIN_CLASSES` / `isLockedEngineClassId` | Stable string ids for engine types; locked ids (including `UserInterface`, `Widget`, and every `*Widget`) cannot be reparented |
| `createWorldSnapshot` | Canonical JSON-serializable world state for harness goldens |
| `createDebugInspectSnapshot` | Read-only Play inspector tree (`tickIndex` + Game Instance / actors / components + optional `variableTypes`). Not a harness golden |
| `createActorsFromSerializedScene` | Build unspawned World actors from a `SerializedScene` for Play |

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

Registered as typed stubs (asset refs + lifecycle hooks) from day one; `RigidBodyComponent` / `ColliderComponent` are synced by `PhysicsWorldSync` in `@babylonslate/runtime`:

`MeshComponent`, `SpriteComponent`, `TilemapComponent`, `CameraComponent`, `LightComponent`, `SkyboxComponent`, `Text3DComponent`, `AudioComponent`, `ParticleComponent`, `RigidBodyComponent`, `ColliderComponent`, `WidgetComponent`, `AnimationGraphComponent`, `BehaviourTreeComponent`, `NavAgentComponent`, `NavMeshComponent`, `NavMeshBlockerComponent`, `BlockingVolumeComponent`.

Search and Add Component advertise shipped behaviour: `TilemapComponent` is addable (P10 Play loads chunk meshes and Rapier chains). `BehaviourTreeComponent` and `NavAgentComponent` are addable. `NavMeshComponent`, `NavMeshBlockerComponent`, and `BlockingVolumeComponent` are Place Actors only (not Add Component). `BTTask` / `BTDecorator` / `BTService` / `BTComposite` plus the built-in Wait / MoveTo / … classes are inheritable engine bases. `WidgetComponent` stays registered but is hidden until world-space `CreateForMesh` exists. `AudioComponent` is addable and searchable (`audioAssetGuid`, play-on-start, loop, component volume); Play-on-start emits `playSound` with the owning actor as emitter. Compiled graphs call `ctx.playSound` / `ctx.setChannelVolume` / `ctx.setGlobalVolume` (see [audio.md](audio.md)). `SkyboxComponent` is addable and searchable (Place Actors **Environment → Skybox**); `size` default 1000, `faces` six nullable Texture guids (empty = engine default cubemap). It is a scene backdrop mesh, not IBL and not a Content Browser document (see [render.md](render.md) and [engineplan §2.5](../engineplan.md)). `Text3DComponent` is addable and searchable (catalog **3D Text**, Place Actors **Environment → 3D Text**, Lucide `TypeIcon`); `text` default `"Text"`, `size` `1`, `color` white, optional Font `fontAssetGuid` (facetype chunk). Flat triangulated TypeFace mesh, not UserInterface `TextBlock` and not Development Only (see [fonts.md](fonts.md) and [render.md](render.md)). `ParticleComponent` is addable and searchable (`particleSystemGuid`, play-on-start, sorting layer/order); Play-on-start emits `assignParticle`. Compiled graphs call `ctx.playParticles` / `ctx.stopParticles` (see [particles.md](particles.md)). Add Component also lists **Project** rows that create the matching engine component with the asset guid already set (Model / Mesh → `MeshComponent.assetGuid`, Audio, ParticleSystem, Sprite, Tilemap, AnimationGraph, BehaviourTree). User Class assets whose ancestry includes `ActorComponent` and not `Actor` are addable; Widget / NavMesh subclasses stay hidden. There is no `ModelComponent` — imported models bind on `MeshComponent.assetGuid`.

See [physics.md](physics.md) for RigidBody / Collider property schemas, pairing warnings, collider TRS bake, named collision layers, and backend sync.

## UserInterface / Widget

`ClassRegistry` registers `UserInterface` and `Widget` as `BObject` bases (`kind: "object"`) plus one locked subclass per authored widget kind. Project assets use `userInterfaceClassId(guid)` → `UserInterface:<guid>` (`userInterfaceAssetClassDef`). Apply owns the instance: widgets point at `owner`, `guid` is `ui-N:widgetId`. Remove tears widgets down in reverse (`destroyed`, `onDestroyed`, `owner = null`), then the UI (`onDestroyed`), emits `uiRemove`, and drops the instance from the runtime map — it never enters the World actor list. See [ui-runtime.md](ui-runtime.md).

`createActorsFromSerializedScene` (same package) builds unspawned World actors from a `SerializedScene` — ids, actor transforms, and component properties plus each component’s local `transform` / `parentId` — so Play can instantiate the authored document without the editor touching Babylon.

## ScriptInterface dispatch

- An interface def is a guid plus method signatures (name, input/output pin defaults as plain values).
- `dispatchInterface(target, interfaceGuid, method, args)` invokes a registered handler or returns pin defaults (no-op).
- Classes declare implemented interface guids; handlers are injectable so P5 can bind compiled graphs without changing the dispatch shape (see [scripting.md](scripting.md)).
- `World.createActor` copies `ClassRegistry.inheritedInterfaces` onto the instance unless the caller passes `implementedInterfaces`. `UserInterface` / `Widget` instances are created by the runtime apply path, not `createActor`.
- Play `ScriptHost.callInterface` calls `dispatchInterface` against the world's `InterfaceRegistry` so a missing implementation returns pin defaults instead of `undefined`.
- `ScriptHost.invokeEvent(classId, event, self?, args?)` and compiled `ctx.invokeCustomEvent(target, eventName, args)` pass `args` into the entry as `ctx.commandArgs` (alias `ctx.args`). Cross-instance Call dispatches on `target.classId` with `self = target`. `ctx.invokeFunction(target, functionName, args)` looks up `exports[functionName]` on `target.classId` (function graphs have no lifecycle `point.event`) and returns the result or `{}`, or a Promise of that object when the export is async. See [scripting.md](scripting.md).

## Re-parenting

`ClassRegistry.reparent(classId, newParentId)`:

- Rejects cycles.
- Rejects engine locked ids (`isLockedEngineClassId`: bases, engine components, Widget subclasses, BT builtins).
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
