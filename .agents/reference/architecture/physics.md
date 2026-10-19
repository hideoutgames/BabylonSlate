# Physics

Simulation in the game worker: the `PhysicsBackend` port, Havok / Rapier / software backends, `PhysicsWorldSync`, components, contacts and script queries.

## Decisions

- Physics runs **inside the game worker** beside scripts, not in its own worker. Same-tick queries (`lineTrace`, `sphereOverlap`, `shapeSweep`, `moveCharacter`) return on the calling exec pin. Bodies never cross a thread; only resolved transforms enter the snapshot. The port stays transport-agnostic so a later split remains possible. A separate physics worker is not planned.
- One world kind per scene: `SceneSettings.physicsWorld: "3d" | "2d"` (defaults from `viewportMode`). A scene never mixes worlds. Each SceneLayer with Enable Physics gets its own 2D world and gravity; layers and the main world never collide ([scene-layers.md](scene-layers.md)).
- 3D is Havok through Babylon Physics V2 on a worker-local `NullEngine` Scene that is never drawn; the interface is shaped around Havok. 2D is `@dimforge/rapier2d-deterministic-compat` 0.21 (embedded wasm, enhanced determinism for trace replay). Constraining Havok to a plane was rejected (it distorts impulses). `planck.js` is not used.
- `SoftwarePhysicsBackend` (AABB) is for tests and explicit fallback only. Play and Preview Build pass `allowSoftwareFallback: false`: a failed engine load reports an error and simulation stays stopped. Software has no constraint solver or slopes.
- Engines load lazily at Play (opening the editor never fetches physics wasm). A 3D export without physics SceneLayers omits Rapier; a 2D export omits Havok.
- Within-build determinism is required (same build, backend and inputs → same transforms). Havok vs Rapier file goldens are never required; a Rapier upgrade changes 2D results between builds. Work reductions must leave `stringifyWorldSnapshot(createWorldSnapshot(world))` unchanged for acyclic hierarchies.
- Out of scope: a collision matrix (named layers + mask only), configurable per-channel responses, a `CharacterControllerComponent`, flying/stair-climbing Movement, moving-platform carry, ragdoll get-up or animation blend.

## Ownership

| Area | Source |
| --- | --- |
| Port, shapes, hits, contact events | [`backend.ts`](../../../packages/physics/src/backend.ts), [`types.ts`](../../../packages/physics/src/types.ts) |
| Backend factory (`createPhysicsBackend`, `loadRapier2DBackendFactory`) | [`create-backend.ts`](../../../packages/physics/src/create-backend.ts) |
| Havok, Rapier, software | [`havok-backend.ts`](../../../packages/physics/src/havok-backend.ts), [`havok-native-adapter.ts`](../../../packages/physics/src/havok-native-adapter.ts), [`rapier-backend.ts`](../../../packages/physics/src/rapier-backend.ts), [`software-backend.ts`](../../../packages/physics/src/software-backend.ts) |
| Collider TRS bake, validation, pairing diagnostics, query filters, ragdoll | [`packages/physics/src/`](../../../packages/physics/src/) `collider-bake.ts`, `collider-validation.ts`, `pairing.ts`, `query-filter.ts`, `ragdoll.ts` |
| Actor ↔ body sync, hosting, channels, constraints | [`physics-sync.ts`](../../../packages/runtime/src/physics-sync.ts) (`PhysicsWorldSync`) |
| Backend loading and swap per world | [`runtime-physics-worlds.ts`](../../../packages/runtime/src/runtime-physics-worlds.ts) |
| Movement motor | [`runtime/src/movement.ts`](../../../packages/runtime/src/movement.ts), defaults in [`core/src/movement.ts`](../../../packages/core/src/movement.ts) |
| Mesh collision modes, complex-collision demand scan | [`mesh-collision.ts`](../../../packages/assets/src/mesh-collision.ts), [`collision-mesh.ts`](../../../packages/core/src/collision-mesh.ts) |

`packages/physics` may import `@babylonjs/core` Physics V2 and `@babylonjs/havok`, never React, Capacitor or editor Babylon packages. `packages/runtime` never imports Babylon.

## Tick and sync

- `TICK_PHASES`: `gameInstance` → `sceneSubsystems` → `actors` → `components` → `physics` → `postPhysics`. Script phases may query the live backend; `physics` steps, writes body poses back, then `pollContacts()`. `scriptMs` and `physicsMs` are timed separately.
- Steps follow the runtime's fixed tick. Scene and SceneLayer `settings.fixedTimestepMs` is still parsed and saved, but nothing reads it and the editor does not show it.
- `PhysicsWorldSync.step` runs for the main world, then each SceneLayer world. Only actors owning a participant component class are candidates (filtered once per structural revision); reassigning `sceneLayerId` must call `world.markStructureChanged()`.
- The pre-step composition is the validation boundary: a parent cycle or unsupported shear throws there, before any native change. Physics uses the same actor-world composition as snapshots (`local × parentWorld`).
- Readback writes dynamic and kinematic poses back as actor-local TRS through the post-step parent transform; it never writes static poses. Static bodies (explicit or implicit) follow their actor one way and are teleported only when their composed pose changed. Following is a velocity-less teleport, so use a kinematic body for moving platforms.
- **Hosted shapes:** a collidable static actor under a dynamic/kinematic ancestor becomes child shapes of the nearest such ancestor's body (like a Unity child collider). Its triggers stay on a separate following static body. Hosts are reassigned every pre-step pass; joints owned by a hosted actor attach to the host.
- Call-time paths (`teleportActor`, `applyComponent`, `moveCharacter`, `sampleWater`, Project Cursor To Scene) resolve only the chains they touch; they never read the last pre-step composition.
- Change Scene retires departing actors before replacing a backend of a different dimension; SceneLayer worlds survive. Late native allocations after cancellation are disposed.

## Bodies and components

| Component | Rule |
| --- | --- |
| `RigidBodyComponent` | `motionType` `static`/`kinematic`/`dynamic`, mass (Inspector ≥ 0.001; backends floor ≤ 0 at 1e-6), damping, `gravityScale` |
| `ColliderComponent` | 3D or 2D `shape`, friction, restitution, `isTrigger`, `layer`, `mask`, `renderInGame` (default false). Component transform is baked into the `ColliderDesc` |
| `MeshComponent` | `collisionMode` `simple`/`complex`/`none`; **new components default `none`** (opt-in), a missing value parses as `simple`. 3D only |
| `LandscapeComponent` | `collisionsEnabled` default false; triangle mesh from the heightfield |
| `BlockingVolumeComponent`, Tilemap, `DynamicRuntimeMeshComponent` (Enable Collision) | Implicit static body |
| Movement | Two modes by Rigid Body ([Movement](#movement)): a kinematic capsule (radius 0.4, height 1.8 world units, ignores actor scale) moved by a character controller, or steering of a dynamic Rigid Body. Not with a static Rigid Body, Nav Agent, Ragdoll, Water Buoyancy or a second Movement on one actor; not in SceneLayers |
| Physics Constraint | Fixed, Ball Socket, Hinge (both backends), Distance (Havok only) |
| Ragdoll | 3D Model actors only, ≤ 128 bones, one per actor; not in 2D or SceneLayers |

- Simulation needs a body source **and** a shape on one actor. A body source is a Rigid Body, Water Buoyancy (3D) or an implicit static body (Mesh collision with resolved shapes, Blocking Volume, Tilemap, enabled Landscape and Dynamic Runtime Mesh; Mesh, Landscape and Dynamic Runtime Mesh are 3D only). Every Collider on the actor attaches to whichever body it has, an implicit one included, so a trigger Collider works beside a collidable Mesh; the capsule of Movement's character controller is the exception and ignores Colliders. A Collider with no body source is not simulated, and a Collider is never auto-added.
- `physicsActorDiagnostics` (pure, mirrors `classifyActor` and `collectOwnColliders`) reports `physics.collider_without_body`, `physics.body_without_collider`, `physics.movement_conflict` (a Movement beside a static Rigid Body, Nav Agent, Ragdoll, Water Buoyancy or another Movement; a dynamic or kinematic Rigid Body is fine, so is a Rigid Body without a Collider) and the Mesh cases `physics.mesh_collision_empty` (Use Simple Collision on a Model known to have no simple shapes) and `physics.mesh_collision_2d` (Mesh collision where the physics world is 2D). They are warnings, never Play blockers. Its optional context carries the scene's `physicsWorld` (a Class prefab omits it and skips the 2D check) and `modelSimpleColliderCount`, from the open Model tab then the registry header; an unknown Model never warns. Complex collision cannot be checked at author time.
- Shapes: 3D box, sphere, capsule, cylinder, convex hull, triangle mesh (cone bakes to a hull). 2D box, circle, capsule, polygon, chain (tilemap layers merge chains). Explicit shapes for the other world kind are rejected.
- `bakeColliderLocal`: sizes = actor × component scale; translation scaled by actor scale only; local rotation on the desc. Shear from oblique rotation under nonuniform scale is rejected explicitly.
- Complex collision is a `CollisionTriangleMesh` (flat typed arrays, transferable). `complexCollisionModelGuids` cooks only Models used with Complex Collision; a miss at runtime sends `requestComplexCollision` once per Model and the host answers `loadComplexCollision` (or `physics.complex_collision_unavailable`). The worker never receives a GLB.
- Collider geometry assigned to a component is copied and frozen; replace a shape rather than mutating its vertices.
- Collision layers: Project Settings `physics.collisionLayers` (default `["Default"]`, max 32); `layer` is one bit, `mask` 32 bits; both colliders must admit each other. Rapier hooks preserve bits above 15.

## Movement

`classifyActor` makes a Movement component the body source unless Nav Agent, Ragdoll, Water Buoyancy, a second Movement or a **static** Rigid Body owns the actor; `movementDrive` (call-time mirror) resolves the mode from the first Rigid Body's motion type.

| Rigid Body | Mode | Body |
| --- | --- | --- |
| none, or kinematic | character controller | Kinematic body from `MOVEMENT_BODY_PROPERTIES`, one upright capsule from Movement Radius and Height, moved by `moveMovement` ([`movement.ts`](../../../packages/runtime/src/movement.ts) computes the velocity; gravity is Movement's Gravity Scale) |
| dynamic | steering | The Rigid Body's own body, mass, damping and Gravity Scale (Movement's does not apply), its Colliders and implicit Mesh collision, or the capsule when it has no solid shape |

- **Steering** runs in the `beforeStep` hook: Movement reads `movementBody` (the body's velocity and the ground normal), moves the horizontal velocity toward the input with the motor's Acceleration / Braking / Air Control math (`steer`), adds Jump Speed (`max(vy, 0) + jumpSpeed`) when grounded or in coyote time, caps downward speed at Max Fall Speed, and writes back only changed axes through `setActorLinearVelocity`. A script-written velocity (`Set Velocity`, `Add Velocity`, `Stop Immediately`) replaces the body's for one step on all axes. Vertical speed is otherwise left to physics. 2D uses x as horizontal and y as up.
- **Upright:** the body is created or updated with `RigidBodyDesc.lockRotation` while a dynamic Rigid Body has a Movement, so collisions and impulses never turn it. Havok sets zero inertia (pitch, roll and yaw), Rapier calls `lockRotations`, software ignores angular writes. Yaw stays under scripts and facing logic, which teleport the body. Removing Movement unlocks the body.
- **Grounded** is `groundUnder`: each of the body's own solid shapes (not triggers, hosted shapes, meshes or chains) is swept down from 5 cm above its pose to Ground Snap Distance + 2 cm below it, and a hit whose normal is within Max Slope Angle of up counts, unless the body moves away from the surface faster than 0.5. The query ignores collision layers and sees the pose the last step left, so transitions lag a tick behind the contact. A body not created yet reads as airborne.
- **Add Impulse** reaches the body in steering mode. In controller mode `MovementWorldSync.addImpulse` (routed from `createPhysicsHostBindings` after ragdolls) adds impulse × strength / mass to Movement's velocity: mass 1 without a Rigid Body, the Rigid Body's Mass (floored at 0.001) when kinematic.
- **Known limits:** a standing steered body on a slope creeps because the capsule has no friction (it must not stick to walls); moving platforms do not carry it.

## Contacts

- `pollContacts()` returns `hit` (with location and normal A → B), `overlapBegin`, `overlapEnd` since the last poll. A blocking pair emits `hit` every poll while touching; a pair with any trigger emits only begin/end overlap.
- Havok is asked for native contact events only while a script on the actor's class (or a hosted child's) handles On Hit / Begin / End Overlap. `generateHitEvents` / `generateOverlapEvents` skip script dispatch only.
- Compound shapes share one actor-pair overlap lifetime. Teleports and same-ID collider changes keep surviving overlaps open (no repeated Begin Overlap); adding/removing colliders re-establishes them.
- Collider ids encode `[actorGuid, componentGuid]` or `[actorGuid, componentGuid, shapeId]` (Mesh); dispatch restores the authored component id.

## Script queries

- Queries run against the calling script's world (main, its SceneLayer's, or a miss for a layer without physics). Misses return false, zero vectors, null Actor and zero distance.
- `shapeSweep` is linear on every backend (start rotation kept; initial overlap hits at distance 0). `sphereOverlap` lists each body and shape owner once. `ignoreActorIds` skips only the named actors' own shapes.
- Collision Channel: All (includes triggers), Static, Dynamic (includes ragdoll bones), Character (Movement owners), Solid, Triggers. Unknown names answer as All with a `physics.channel` warning. Line Trace Draw Debug never draws in release exports.
- `moveCharacter` lazily creates a controller on the actor's body (no dedicated component) and applies the result immediately. Havok and Rapier enforce slope limits natively; software cannot.

## Native adapter rules

- Babylon 9.29.0 and Havok 1.3.14 are pinned with a repository patch: detaching the last shape uses `HavokPlugin.setShape(body, null)` with a `[0n]` null handle, because the setter alone does not detach geometry.
- Attachment changes and teleports remove and reinsert the same native body handle to refresh world/query membership without a solver step; native removal sends no trigger exit, so the adapter ends pair generations explicitly.
- `applyColliderChanges` prepares all upserts/removals before attaching; failed preparation keeps the working set, failed attachment rolls back. Native bodies retire before their shapes. Requests during contact callbacks queue until the step finishes.
