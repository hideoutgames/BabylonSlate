# Physics (P7)

Shared surface for simulation in the game worker (engineplan §2.1, §2.3, §13.4). Implementation: `@babylonslate/physics`.

## Placement

- Physics runs **inside the game worker** beside scripts — not a separate worker.
- Same-tick queries (`lineTrace`, `sphereOverlap`, `shapeSweep`) return on the **calling execution pin**.
- Bodies never cross a thread boundary; only resolved transforms enter the snapshot buffer.
- The backend interface is **transport-agnostic** so a future worker split stays possible without reshaping the object model.

## Package API (`@babylonslate/physics`)

| Export | Role |
| --- | --- |
| `PhysicsBackend` | Port: world lifecycle, bodies/colliders, `step(dt)`, `pollContacts()`, sync queries, impulses, live `updateBody` / `updateCollider` |
| `PhysicsWorldKind` | `"3d"` \| `"2d"` — one kind per scene |
| `NullPhysicsBackend` | In-memory no-op for tests without wasm |
| `createPhysicsBackend` | Lazy factory; dynamic-imports only the needed engine |
| `bakeColliderLocal` | Actor × component scale into shape sizes; scaled local translation; local rotation on `ColliderDesc` |
| `physicsActorDiagnostics` | Pairing warnings (`physics.collider_without_body` / `physics.body_without_collider`); tilemaps exempt |
| Shape / body / hit types | Shared descriptors shaped primarily around Havok |

Depends on `@babylonslate/core` at the type layer plus `@babylonjs/core` Physics V2 and `@babylonjs/havok` for 3D. No React, no Capacitor, no editor Babylon packages (gui/loaders/inspector). `@babylonslate/runtime` still must not import Babylon.

## Backends

| Kind | Engine | When loaded |
| --- | --- | --- |
| `3d` | Babylon Physics V2: `HavokPlugin` + `PhysicsAggregate` on a worker-local `NullEngine` Scene | Scene `physicsWorld === "3d"` |
| `2d` | `@dimforge/rapier2d-compat` | Scene `physicsWorld === "2d"` |
| either | `SoftwarePhysicsBackend` (AABB) | `preferSoftware`, tests, or wasm load failure |

- Havok is the **primary** 3D backend; the interface is shaped around it.
- A 3D-only play/export must not download Rapier (and vice versa).
- The physics Scene is **not** the editor/render Scene. It is never drawn; the worker steps with `getPhysicsEngine()!._step(dt)`. Queries use `PhysicsEngine.raycast` and `HavokPlugin.shapeCast`.
- `SoftwarePhysicsBackend` is not a stand-in for 3D Play — it is the deterministic test/fallback path.

Rejected alternative for 2D: constraining Havok (companion anchor + 6DOF per body + inertia zeroing that distorts impulses). See engineplan §13.4.

## Scene declaration

`SceneSettings.physicsWorld: "3d" | "2d"` (defaults from `viewportMode` on create). A scene never mixes worlds. Overlay **SceneLayer** actors always simulate in a dedicated Rapier 2D world on the Play session, independent of that world setting — overlay and world bodies do not collide. See [scene-layers.md](scene-layers.md). Collider shape variants that do not apply to the active world are coerced to that world's default box at parse time (`parseColliderProperties`); a mixed-shape diagnostic is a named P7 polish follow-up, not current behaviour.

## Tick integration

Order (from P3): `gameInstance` → `actors` → `components` → **`physics`** → `postPhysics`.

1. Script phases may call sync queries on the live backend.
2. `physics` phase: `backend.step(dt)`, then write body transforms back to Actors, then `pollContacts()` (see Contact events).
3. `RuntimeDriver` times script phases and the physics phase separately into snapshot/`stats` `scriptMs` and `physicsMs`.

Play (in-process and the game worker) constructs a `SoftwarePhysicsBackend`, then `RuntimeDriver.loadPhysics()` swaps in Havok or Rapier and re-syncs already-spawned bodies. `preferSoftwarePhysics` skips the swap (unit tests / wasm-free CI).

The Play `load` control message carries `sceneAssetGuid`, optional authored `scene` (`SerializedScene`), `physicsWorld`, `gravity`, and `havokWasmUrl`. The editor vendors `HavokPhysics.wasm` at `/havok/HavokPhysics.wasm` (same self-host pattern as the KTX2 transcoder) so browser Play does not silently keep the AABB backend. Details / Actor Prefab Add Component lists include `RigidBodyComponent` and `ColliderComponent`.

Play instantiates the open `SerializedScene` on `RuntimeDriver.realizePlayWorld()` (after scripts load so Begin Play binds on spawn). Demo actors are not seeded when a scene payload is present. `PhysicsWorldSync` then creates bodies for authored `RigidBodyComponent` **plus** `ColliderComponent`, a static body plus merged chain colliders for `TilemapComponent` (see [tilemaps.md](tilemaps.md)), a **static** body plus box collider for `BlockingVolumeComponent` (half-extents `|scale|/2`, world rotation from actor TRS; no RigidBody required), and **MeshComponent** collision in 3D worlds (`collisionMode` ≠ `none` with resolved shapes). Collider-only actors are skipped unless Mesh collision, a tilemap, or a blocking volume supplies an implicit static body (`if (!rigid && !tilemap && !blocking && !meshCollision) return`). RigidBody-only actors spawn a body with **no shapes**. Mesh **Use Simple Collision** instantiates Model `simpleColliders` (or primitive built-ins). **Use Complex Collision** cooks the rest-pose visual triangle mesh (Play host extracts vertices/indices; the worker never receives the GLB). **No Collision** emits nothing from that MeshComponent. Extra `ColliderComponent` volumes still work. Dynamic / kinematic still use `RigidBodyComponent`. 2D worlds skip MeshComponent collision (sprites/tilemaps own 2D collision). Actors with `SpriteComponent` + `box2d` `ColliderComponent` rebuild the box from the current Sprite / Sprite Animation frame AABB each tick ([sprites.md](sprites.md)); leaving a sprite clip restores the Sprite default box. Circle / capsule / polygon stay authored. Graph-only spawns skip class ids that already exist as scene actors. `createPlayBootCoordinator` still `start`/`resume`s if `loadPhysics` rejects, and reports `loadScripts` failures without blocking Play. `loadModels` posts Model JSON headers plus cooked complex meshes (same idea as `loadSprites`).

## Components

| Component | Properties (core) |
| --- | --- |
| `RigidBodyComponent` | `motionType` (`static` \| `kinematic` \| `dynamic`), `mass`, `linearDamping`, `angularDamping`, `gravityScale` |
| `ColliderComponent` | `shape` (3D or 2D variant), `friction`, `restitution`, `isTrigger`, `layer`, `mask`, `renderInGame` (default **false**). Local `component.transform` is baked into `ColliderDesc` (translation, rotation, scaled sizes). |
| `MeshComponent` | `collisionMode` (`simple` \| `complex` \| `none`, default **simple**), `layer` (default `1`), `mask` (default `0xffffffff`). 3D only. Simple uses Model `simpleColliders` or primitive built-ins; complex uses the visual triangle mesh (rest-pose; skinned meshes do not animate the collider). Friction/restitution use ColliderComponent defaults (0.5 / 0). Collider ids are `mesh-collider:${component.guid}:${shapeId}`. |
| `BlockingVolumeComponent` | No authored properties. Place Actors **Physics → Blocking Volume** only (hidden from Add Component / Search). Editor: blue dotted unit box + `default.png` at the center. Play: helper hidden; static physics box from actor TRS. Not a navmesh input. |

Simulation needs **both** a rigid body and at least one collider on the same actor (tilemaps, **blocking volumes**, and **MeshComponent** collision that is not `none` are the exception: they create an implicit static body). That pairing is the authored workflow — not a Play blocker. Compile warnings:

| Case | Code | Severity |
| --- | --- | --- |
| Collider, no RigidBody, no Tilemap, no Blocking Volume, no Mesh collision | `physics.collider_without_body` | warning (one per collider) |
| RigidBody, no Collider, no Tilemap, no Blocking Volume, no Mesh collision | `physics.body_without_collider` | warning |
| Tilemap, Blocking Volume, or MeshComponent collision with or without RigidBody | none | OK |

`physicsActorDiagnostics` in `@babylonslate/physics` is the pure check (no React). Scene **Compiler Results** (Output Log tab) lists them; tap selects the actor. Prefab / Class Compiler Results merge the same warnings for `SerializedGraph.components` (`actorId` = Prefab Root). Diagnostics may carry `actorId` / `componentId`.

### Contact events

`pollContacts()` returns `{ kind: "hit" | "overlapBegin" | "overlapEnd", actorAId, actorBId, colliderAId?, colliderBId?, location, normal }` since the previous poll. Collider ids are `collider:${component.guid}` (ColliderComponent) or `mesh-collider:${component.guid}:${shapeId}` (MeshComponent). Software, Havok, and Rapier 2D populate them. **v1:** a blocking pair emits `hit` every poll while overlapping; if either collider `isTrigger`, the pair emits begin/end overlap only (no hit). Software AABB implements that rule; Havok maps blocking `COLLISION_STARTED` / `COLLISION_CONTINUED` to hit and trigger enter/exit to overlap (body-level contacts, so multi-collider actors use the first collider id on each actor); Rapier drains `EventQueue` collision events after `step` and keys pairs by collider handle. `RuntimeDriver` dispatches after `step` onto the matching actor entries bound to that collider id (see [scripting.md](scripting.md) Entry points). Actor flags `generateHitEvents` / `generateOverlapEvents` skip script dispatch only.

Spawn/attach creates bodies; destroy removes them (`PhysicsWorldSync` drops backend bodies when the actor leaves the live set). Bodies use the same composed world-space actor hierarchy as render snapshots. After `step`, body poses are converted through the inverse parent transform back into Actor-local TRS before `postPhysics`; a parented body therefore does not jump between local simulation and world rendering. Static and kinematic bodies copy the composed actor transform on resync; dynamic bodies keep the simulation transform. `addImpulse` is a no-op when the actor has no body. Tilemap chain colliders skip `collision: false` layers and missing guid/tileset payloads.

Graph **Set** of RigidBody / Collider catalog variables is not store-only. `setVariableOn` → `refreshComponent` → `PhysicsWorldSync.applyComponent`: `updateBody(body:${actor.guid}, RigidBodyTuning)` retunes mass, linear/angular damping, gravity scale, and motion type; `updateCollider(collider:${component.guid}, ColliderTuning)` retunes `isTrigger`, friction, restitution, layer, and mask. Software, Rapier, and Havok implement both. Collider `shape` is not a catalog knob — changing shape still requires recreate. Unit coverage lives in `packages/runtime/src/physics-sync.test.ts`, `packages/physics/src/physics.test.ts`, and `packages/physics/src/pairing.test.ts`.

### Collider TRS bake

`bakeColliderLocal` (before `createCollider`, including sprite `box2d` rebuilds):

- **Sizes:** actor scale × component scale. Box half-extents per axis; sphere radius from max abs scale; circle from max abs XY; capsule radius from XZ (2D capsule from X), halfHeight from Y; polygon / chain / convex / mesh points scaled per axis.
- **Translation:** actor scale only (same as `composeActorComponentTransform` light/camera offsets).
- **Rotation:** component local quaternion on optional `ColliderDesc.rotation`. Havok `PhysicsShapeBox` / capsule endpoints use it; Rapier `setRotation(quatToPlanarAngle)`; software AABB rotates the test box.

### Collision layers

Project Settings → **Physics** stores `settings.physics.collisionLayers` (`NamedListEditor`, default `["Default"]`, cap 32, same normalize pattern as sorting layers). Bit storage stays 32-bit for Havok membership/collide masks (`layer` = `1 << index`; Default → `1`). Collider Details: **Layer** is a single-bit Select; **Collides With** is a `FlagsField` of named bits only. No collision matrix in this slice.

### Editor / Play visuals

RigidBody-only actors use a camera-facing **`default.png` billboard** (Play `playHelperVisual`) — never a 0.25 cube. `ColliderComponent` is an `EditorSceneSync` **world visual** (opaque dashed segment meshes, `RENDERING_GROUP.world`, depth-tested). Editor always draws those dashes **and** MeshComponent-owned dashes (simple/complex). Play/export draws ColliderComponent dashes only when `renderInGame` is true (`meshKind` `collider:{json}`). Mesh collision dashes stay editor-only; Play uses console `showcollision` (`listDebugColliders()`, including capsules, Blocking Volume static boxes, and Mesh colliders). See [render.md](render.md) and [scene-editing.md](scene-editing.md).

### Shapes

- **3D:** box, sphere, capsule, cylinder (Havok `PhysicsShapeCylinder` when present, else a convex prism), convex hull, triangle mesh. Cone is not a first-class kind — it bakes to a convex (apex + base ring).
- **2D:** box, circle, capsule, polygon, chain (tilemap chunks emit merged chains via `tilemapChunkChains`)

Editor clicks are **mesh picks**, not physics. Collider dashes are unpickable in the Scene viewport; Mesh / Sprite / Tilemap stay the pick target when present. Physics-only actors pick via the origin proxy / default billboard. Havok/Rapier colliders exist in Play when the actor has authored `RigidBodyComponent` + `ColliderComponent`, a Tilemap, a Blocking Volume, or 3D **MeshComponent** collision (`collisionMode` ≠ `none` with resolved shapes). Details / Prefab Add Component lists box, sphere, and capsule (2D: box2d, circle, capsule2d). Cylinder is a first-class 3D physics kind for Model simple colliders and the primitive Mesh table (not a ColliderComponent Add-Component enum). **Simple collision** lives on the Model asset (`simpleColliders`: box, sphere, capsule, cylinder, cone, generated convex hull). Import of a static mesh (`skeletonGuid == null`) stamps one generated hull; a Skeleton leaves the list empty. **Add → Generated Collision** re-cooks the hull from the Model `source` chunk (disabled until that chunk is loaded). Degenerate meshes fall back to a bounds box named Generated Collision. **Use Complex Collision** uses the visual triangle mesh (rest-pose GLB or primitive tessellation); it does not animate with a skin. Existing Model files normalize missing `simpleColliders` to `[]` (no rewrite). 3D Empty scaffolds Kenney Mannequin Class and `actor-1` with a **kinematic** rigid body and a capsule (`radius` 0.5, `halfHeight` 1, Y offset `radius + halfHeight` so it sits on the feet origin). New Empty 3D projects only — existing scenes are not migrated.

## Scripting

Sync nodes (exec pin continues in the same tick): `physics.lineTrace`, `physics.sphereOverlap`, `physics.shapeSweep`, `physics.addImpulse`, `physics.moveCharacter`. Dragging off **Get Rigid Body** also Calls **Add Impulse** (`callComponentFunction` `addImpulse`) on that owner.

- **Line Trace** returns Hit Result plus exploded Hit, Location, Normal, Distance, and a live Actor reference.
- **Sphere Overlap Actors** keeps the `physics.sphereOverlap` id for existing graphs and returns a deterministic, de-duplicated live Actor array plus Int Count. Missing or destroyed actor ids are filtered.
- **Sphere Shape Sweep** exposes Radius and returns the same Hit Result / exploded query fields as Line Trace.
- Query misses return false, null vectors/Actor, and zero Distance rather than leaking backend ids or typed `undefined`. Radius defaults at or below zero emit `physics.radius`.
- Every query has an optional **Collision Channel** (default All). In 2D, authored `vec3` points use XY.

`moveCharacter` takes an Actor (defaults to `self`), lazily creates a character controller on that actor’s rigid body (`id` = actor guid, optional `offset` default 0.01), and applies the returned transform to the actor immediately so the next kinematic sync keeps it. Destroy follows the rigid body. No `CharacterControllerComponent` in this slice.

`ScriptHost` binds trace / overlap / sweep / impulse to the active backend and resolves returned actor ids through the live World before compiled graph code receives them.

## Determinism

Harness scenarios run on each backend where shapes overlap. Within-backend reproducibility is required. Do not require identical Havok vs Rapier **file** goldens — numeric drift between engines is expected.

## Deferred

| Item | Owner |
| --- | --- |
| `physics.moveCharacter` scripting (backend CC exists) | Done (`p7-character-controller`) — Actor pin, lazy CC, no dedicated component |
| Mixed 2D/3D collider diagnostic | P7 polish |
| Collision layer matrix | Not in this slice; named layers + mask only |
| Rapier `shapeSweep` ≈ lineTrace; Havok `sphereOverlap` uses AABB | P7 polish / as needed by gameplay |
| Tilemap merged chain colliders | Done (`p10-tilemap`) — `tilemapChunkChains` + `PhysicsWorldSync` static body per `TilemapComponent`; Rapier closed loops add a closing segment collider |
| Full 5 Hz debugger stats HUD | P8 (`p8-console-hud`); P7 exposes `physicsMs` + Play overlay readout |
| `planck.js` fallback | Not used; software AABB is the wasm-failure path |
| Separate physics worker | Not planned for v1 |
