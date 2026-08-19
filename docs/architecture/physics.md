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
| `PhysicsBackend` | Port: world lifecycle, bodies/colliders, `step(dt)`, sync queries, impulses |
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

`SceneSettings.physicsWorld: "3d" | "2d"` (defaults from `viewportMode` on create). A scene never mixes worlds. Collider shape variants that do not apply to the active world are coerced to that world's default box at parse time (`parseColliderProperties`); a mixed-shape diagnostic is a named P7 polish follow-up, not current behaviour.

## Tick integration

Order (from P3): `gameInstance` → `actors` → `components` → **`physics`** → `postPhysics`.

1. Script phases may call sync queries on the live backend.
2. `physics` phase: `backend.step(dt)`, then write body transforms back to Actors.
3. `RuntimeDriver` times script phases and the physics phase separately into snapshot/`stats` `scriptMs` and `physicsMs`.

Play (in-process and the game worker) constructs a `SoftwarePhysicsBackend`, then `RuntimeDriver.loadPhysics()` swaps in Havok or Rapier and re-syncs already-spawned bodies. `preferSoftwarePhysics` skips the swap (unit tests / wasm-free CI).

The Play `load` control message carries `sceneAssetGuid`, optional authored `scene` (`SerializedScene`), `physicsWorld`, `gravity`, and `havokWasmUrl`. The editor vendors `HavokPhysics.wasm` at `/havok/HavokPhysics.wasm` (same self-host pattern as the KTX2 transcoder) so browser Play does not silently keep the AABB backend. Details / Actor Prefab Add Component lists include `RigidBodyComponent` and `ColliderComponent`.

Play instantiates the open `SerializedScene` on `RuntimeDriver.realizePlayWorld()` (after scripts load so Begin Play binds on spawn). Demo actors are not seeded when a scene payload is present. `PhysicsWorldSync` then creates bodies for authored `RigidBodyComponent` **plus** `ColliderComponent`, and a static body plus merged chain colliders for `TilemapComponent` (see [tilemaps.md](tilemaps.md)). Collider-only actors are skipped (`if (!rigid && !tilemap) return`). RigidBody-only actors spawn a body with **no shapes**. Actors with `SpriteComponent` + `box2d` `ColliderComponent` rebuild the box from the current Sprite / Sprite Animation frame AABB each tick ([sprites.md](sprites.md)); leaving a sprite clip restores the Sprite default box. Circle / capsule / polygon stay authored. Graph-only spawns skip class ids that already exist as scene actors. `createPlayBootCoordinator` still `start`/`resume`s if `loadPhysics` rejects, and reports `loadScripts` failures without blocking Play.

## Components

| Component | Properties (core) |
| --- | --- |
| `RigidBodyComponent` | `motionType` (`static` \| `kinematic` \| `dynamic`), `mass`, `linearDamping`, `angularDamping`, `gravityScale` |
| `ColliderComponent` | `shape` (3D or 2D variant), `friction`, `restitution`, `isTrigger`, `layer`, `mask`, `renderInGame` (default **false**). Local `component.transform` is baked into `ColliderDesc` (translation, rotation, scaled sizes). |

Simulation needs **both** a rigid body and at least one collider on the same actor (tilemaps are the exception: they create an implicit static body). That pairing is the authored workflow — not a Play blocker. Compile warnings:

| Case | Code | Severity |
| --- | --- | --- |
| Collider, no RigidBody, no Tilemap | `physics.collider_without_body` | warning (one per collider) |
| RigidBody, no Collider, no Tilemap | `physics.body_without_collider` | warning |
| Tilemap with or without RigidBody | none | OK |

`physicsActorDiagnostics` in `@babylonslate/physics` is the pure check (no React). Scene **Compiler Results** (Output Log tab) lists them; tap selects the actor. Prefab / Class Compiler Results merge the same warnings for `SerializedGraph.components` (`actorId` = Prefab Root). Diagnostics may carry `actorId` / `componentId`.

Spawn/attach creates bodies; destroy removes them (`PhysicsWorldSync` drops backend bodies when the actor leaves the live set). Bodies use the same composed world-space actor hierarchy as render snapshots. After `step`, body poses are converted through the inverse parent transform back into Actor-local TRS before `postPhysics`; a parented body therefore does not jump between local simulation and world rendering. Static and kinematic bodies copy the composed actor transform on resync; dynamic bodies keep the simulation transform. `addImpulse` is a no-op when the actor has no body. Tilemap chain colliders skip `collision: false` layers and missing guid/tileset payloads. Unit coverage lives in `packages/runtime/src/physics-sync.test.ts` and `packages/physics/src/pairing.test.ts`.

### Collider TRS bake

`bakeColliderLocal` (before `createCollider`, including sprite `box2d` rebuilds):

- **Sizes:** actor scale × component scale. Box half-extents per axis; sphere radius from max abs scale; circle from max abs XY; capsule radius from XZ (2D capsule from X), halfHeight from Y; polygon / chain / convex / mesh points scaled per axis.
- **Translation:** actor scale only (same as `composeActorComponentTransform` light/camera offsets).
- **Rotation:** component local quaternion on optional `ColliderDesc.rotation`. Havok `PhysicsShapeBox` / capsule endpoints use it; Rapier `setRotation(quatToPlanarAngle)`; software AABB rotates the test box.

### Collision layers

Project Settings → **Physics** stores `settings.physics.collisionLayers` (`NamedListEditor`, default `["Default"]`, cap 32, same normalize pattern as sorting layers). Bit storage stays 32-bit for Havok membership/collide masks (`layer` = `1 << index`; Default → `1`). Collider Details: **Layer** is a single-bit Select; **Collides With** is a `FlagsField` of named bits only. No collision matrix in this slice.

### Editor / Play visuals

RigidBody-only actors use a camera-facing **billboard** (procedural cube glyph in `EDITOR_BILLBOARD_ICONS`, Play `playHelperVisual`) — never the empty-actor 0.25 cube. `ColliderComponent` is an `EditorSceneSync` **world visual** (opaque dashed segment meshes, `RENDERING_GROUP.world`, depth-tested). Editor always draws those dashes. Play/export draws them only when `renderInGame` is true (`meshKind` `collider:{json}`). Console `showcollision` stays a **global** Play overlay (`listDebugColliders()`); it does not replace the per-collider property. See [render.md](render.md) and [scene-editing.md](scene-editing.md).

### Shapes

- **3D:** box, sphere, capsule, convex hull, triangle mesh
- **2D:** box, circle, capsule, polygon, chain (tilemap chunks emit merged chains via `tilemapChunkChains`)

Editor clicks are **mesh picks**, not physics. Collider dashes are unpickable; Mesh / Sprite / Tilemap stay the pick target when present. Physics-only actors pick via the RigidBody origin proxy. Havok/Rapier colliders exist in Play only when the actor has authored `RigidBodyComponent` + `ColliderComponent` (or a Tilemap). Details / Prefab Add Component lists box, sphere, and capsule (2D: box2d, circle, capsule2d). There is **no** auto-trimesh baker from a GLB. 3D Empty scaffolds Kenney Mannequin Class and `actor-1` with a **kinematic** rigid body and a capsule sized to the character (Y offset so it sits on the ground). Users add colliders on any other mesh the same way.

## Scripting

Sync nodes (exec pin continues same tick): `physics.lineTrace`, `physics.sphereOverlap`, `physics.shapeSweep`, `physics.addImpulse`, `physics.moveCharacter`. `moveCharacter` takes an Actor (defaults to `self`), lazily creates a character controller on that actor’s rigid body (`id` = actor guid, optional `offset` default 0.01), and applies the returned transform to the actor immediately so the next kinematic sync keeps it. Destroy follows the rigid body. No `CharacterControllerComponent` in this slice.

`ScriptHost` binds `ctx.lineTrace` / overlap / sweep / impulse to the active backend.

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
