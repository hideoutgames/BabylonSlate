# Object model (P3)

Shared surface for the headless runtime object graph (engineplan §5, §16). Implementation lives in `@babylonslate/object-model`. Deterministic harness lives in `@babylonslate/test-kit`.

## Package API (`@babylonslate/object-model`)

| Export | Role |
| --- | --- |
| `BObject` | Base instance: guid, classId, variables, `onCreation` / `onTick` / `onDestroyed` |
| `Actor` | World-placed object with transform and ordered component list |
| `ActorComponent` | Attached to an Actor; own tick |
| `GameInstance` | Session singleton: `onGameStart` / `onTick` / `onGameEnd` / `onSceneLoaded` |
| `World` | Owns GameInstance, actors in spawn order, RNG, deferred destroy, snapshot |
| `ClassRegistry` | Inheritance graph, re-parenting, engine bases and components |
| `TickPhase` / `TICK_PHASES` / `TickClock` | Fixed-dt phases; `physics` filled by `@babylonslate/physics` |
| `ScriptInterface` / `dispatchInterface` | Interface defs and runtime dispatch with pin defaults |
| `ENGINE_BASE_CLASS_IDS` / `ENGINE_COMPONENT_CLASS_IDS` / `ENGINE_BT_BUILTIN_CLASSES` | Stable string ids for engine types (`BObject`, `Actor`, `BTTask`, …) |
| `createWorldSnapshot` | Canonical JSON-serializable world state for harness goldens |
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

## RNG

The world owns a seeded PRNG from `createSeededRng` in `@babylonslate/core`. Simulation code must not call `Math.random`.

## Engine components

Registered as typed stubs (asset refs + lifecycle hooks) from day one; `RigidBodyComponent` / `ColliderComponent` are synced by `PhysicsWorldSync` in `@babylonslate/runtime`:

`MeshComponent`, `SpriteComponent`, `TilemapComponent`, `CameraComponent`, `LightComponent`, `AudioComponent`, `RigidBodyComponent`, `ColliderComponent`, `WidgetComponent`, `AnimationGraphComponent`, `BehaviourTreeComponent`, `NavAgentComponent`, `NavMeshComponent`.

Search and Add Component advertise shipped behaviour: `TilemapComponent` is addable (P10 Play loads chunk meshes and Rapier chains). `BehaviourTreeComponent` and `NavAgentComponent` are addable. `NavMeshComponent` is Place Actors only (not Add Component). `BTTask` / `BTDecorator` / `BTService` / `BTComposite` plus the built-in Wait / MoveTo / … classes are inheritable engine bases. `WidgetComponent` stays registered but is hidden until world-space `CreateForMesh` exists. `AudioComponent` stays registered but is **not** in Search/Add; compiled graphs call `ctx.playSound`, which emits a `playSound` command (Play logs it; there is no mixer yet).

See [physics.md](physics.md) for RigidBody / Collider property schemas and backend sync.

`createActorsFromSerializedScene` (same package) builds unspawned World actors from a `SerializedScene` — ids, transforms, and component properties — so Play can instantiate the authored document without the editor touching Babylon.

## ScriptInterface dispatch

- An interface def is a guid plus method signatures (name, input/output pin defaults as plain values).
- `dispatchInterface(target, interfaceGuid, method, args)` invokes a registered handler or returns pin defaults (no-op).
- Classes declare implemented interface guids; handlers are injectable so P5 can bind compiled graphs without changing the dispatch shape (see [scripting.md](scripting.md)).

## Re-parenting

`ClassRegistry.reparent(classId, newParentId)`:

- Rejects cycles.
- Returns an invalidation list of inherited members that break under the new parent.
- Editor UX for re-parenting stays in P5; P3 owns the registry API only.

## Deterministic harness (`@babylonslate/test-kit`)

| Export | Role |
| --- | --- |
| `runDeterministicScenario` | Seed RNG, fixed dt, N in-process ticks, return canonical snapshot |
| `installHarnessProjectFixtures` | Memory VFS + minimal project/asset JSON stubs |

Acceptance: a 120-tick scenario reproduces a committed golden byte-exactly and is identical across two runs with the same seed.

Worker / SAB comparison lands in P4 via `@babylonslate/bridge` and `@babylonslate/test-kit` multi-transport harness (see [bridge.md](bridge.md)).
