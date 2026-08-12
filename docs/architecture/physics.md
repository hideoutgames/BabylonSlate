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
| Shape / body / hit types | Shared descriptors shaped primarily around Havok |

Depends on `@babylonslate/core` only at the type layer. No React, no Babylon scene APIs. Havok and Rapier are optional runtime deps loaded by kind.

## Backends

| Kind | Engine | When loaded |
| --- | --- | --- |
| `3d` | `@babylonjs/havok` via `HavokPhysics({ locateFile })` | Scene `physicsWorld === "3d"` |
| `2d` | `@dimforge/rapier2d` | Scene `physicsWorld === "2d"` |

- Havok is the **primary** backend; the interface is shaped around it.
- A 3D-only play/export must not download Rapier (and vice versa).
- Babylon `HavokPlugin` / `PhysicsAggregate` / `scene.enablePhysics` are **not** used (no `Scene` in the worker).

Rejected alternative for 2D: constraining Havok (companion anchor + 6DOF per body + inertia zeroing that distorts impulses). See engineplan §13.4.

## Scene declaration

`SceneSettings.physicsWorld: "3d" | "2d"` (defaults from `viewportMode` on create). A scene never mixes worlds. Collider shape variants that do not apply to the active world are ignored at load with a diagnostic.

## Tick integration

Order (from P3): `gameInstance` → `actors` → `components` → **`physics`** → `postPhysics`.

1. Script phases may call sync queries on the live backend.
2. `physics` phase: `backend.step(dt)`, then write body transforms back to Actors.
3. `RuntimeDriver` times script phases and the physics phase separately into snapshot/`stats` `scriptMs` and `physicsMs`.

## Components

| Component | Properties (core) |
| --- | --- |
| `RigidBodyComponent` | `motionType` (`static` \| `kinematic` \| `dynamic`), `mass`, `linearDamping`, `angularDamping`, `gravityScale` |
| `ColliderComponent` | `shape` (3D or 2D variant), `friction`, `restitution`, `isTrigger`, `layer`, `mask` |

Spawn/attach creates bodies; destroy removes them. Transforms after `step` overwrite Actor world transforms before `postPhysics`.

### Shapes

- **3D:** box, sphere, capsule, convex hull, triangle mesh
- **2D:** box, circle, capsule, polygon, chain (tilemap chain generation is **P10**)

## Scripting

Sync nodes (exec pin continues same tick): `physics.lineTrace`, `physics.sphereOverlap`, `physics.shapeSweep`, `physics.addImpulse`, plus 2D kinematic character-controller nodes.

`ScriptHost` binds `ctx.lineTrace` / overlap / sweep / impulse to the active backend.

## Determinism

Harness scenarios run on each backend where shapes overlap. Goldens are per-backend (numeric drift between engines is expected; within-backend reproducibility is required).

## Deferred

| Item | Owner |
| --- | --- |
| Tilemap merged chain colliders | P10 |
| Full 5 Hz debugger stats HUD | P8 (`p8-console-hud`); P7 exposes `physicsMs` + Play overlay readout |
| Separate physics worker | Not planned for v1 |
