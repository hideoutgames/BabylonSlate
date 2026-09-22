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
| `PhysicsBackend` | Port: world lifecycle, bodies/colliders, `step(dt)`, `pollContacts()`, sync queries, impulses, partial world-axis `setBodyLinearVelocity` for dynamic bodies, live `updateBody` / `updateCollider` |
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
| `3d` | Babylon Physics V2: `HavokPlugin` + explicitly owned `PhysicsBody` / shapes on a worker-local `NullEngine` Scene | Scene `physicsWorld === "3d"` |
| `2d` | `@dimforge/rapier2d-compat` | Scene `physicsWorld === "2d"` or a loaded SceneLayer library |
| either | `SoftwarePhysicsBackend` (AABB) | `preferSoftware`, tests, or callers that allow fallback |

- Havok is the **primary** 3D backend; the interface is shaped around it.
- A 3D-only play/export with no SceneLayer documents does not download Rapier; 2D play/export does not download Havok. A 3D world with SceneLayers loads both engines for their separate physics worlds.
- The physics Scene is **not** the editor/render Scene. It is never drawn; the worker steps with `getPhysicsEngine()!._step(dt)`. Queries use `PhysicsEngine.raycast` and `HavokPlugin.shapeCast`.
- `SoftwarePhysicsBackend` is the deterministic test/fallback path. Play and Preview Build request `allowSoftwareFallback: false`; a failed engine load reports an error and leaves simulation stopped.

Rejected alternative for 2D: constraining Havok (companion anchor + 6DOF per body + inertia zeroing that distorts impulses). See engineplan §13.4.

## Scene declaration

`SceneSettings.physicsWorld: "3d" | "2d"` (defaults from `viewportMode` on create). A scene never mixes worlds. Overlay **SceneLayer** actors always simulate in a dedicated Rapier 2D world on the Play session, independent of that world setting — overlay and world bodies do not collide. See [scene-layers.md](scene-layers.md). Explicit collider shapes that do not apply to the active world are rejected by `parseColliderProperties`; an omitted shape still uses that world's default box.

## Tick integration

Order (from P3): `gameInstance` → `actors` → `components` → **`physics`** → `postPhysics`.

1. Script phases may call sync queries on the live backend.
2. `physics` phase: `backend.step(dt)`, then write body transforms back to Actors, then `pollContacts()` (see Contact events).
3. `RuntimeDriver` times script phases and the physics phase separately into snapshot/`stats` `scriptMs` and `physicsMs`.

Play (in-process and the game worker) constructs a `SoftwarePhysicsBackend`, then `RuntimeDriver.loadPhysics()` loads Havok or Rapier before simulation starts and re-syncs already-spawned bodies. When SceneLayer documents are available, their separate Rapier world must also initialize before the swap; failure releases the newly loaded engines. Without those documents, no overlay actors can be created and the empty overlay world stays in software. `preferSoftwarePhysics` skips the swap for explicit software tests. Loading remains deferred until Play, so opening the editor does not fetch physics WASM.

The Play `load` control message carries `sceneAssetGuid`, optional authored `scene` (`SerializedScene`), `physicsWorld`, `gravity`, and `havokWasmUrl`. The editor resolves its vendored `havok/HavokPhysics.wasm` through the deployment base (for example `/BabylonSlate/havok/HavokPhysics.wasm` on Pages) and sends an absolute worker URL. Preview Build resolves its copy relative to the player. An explicit WASM URL must load successfully; Node's package-file lookup is only used when no URL was supplied. Details / Actor Prefab Add Component lists include `RigidBodyComponent` and `ColliderComponent`.

Play instantiates the open `SerializedScene` on `RuntimeDriver.realizePlayWorld()` (after scripts load so Begin Play binds on spawn). Demo actors are not seeded when a scene payload is present. `PhysicsWorldSync` then creates bodies for authored `RigidBodyComponent` **plus** `ColliderComponent`, a static body plus merged chain colliders for `TilemapComponent` (see [tilemaps.md](tilemaps.md)), a **static** body plus box collider for `BlockingVolumeComponent` (half-extents `|scale|/2`, world rotation from actor TRS; no RigidBody required), and **MeshComponent** collision in 3D worlds (`collisionMode` ≠ `none` with resolved shapes). Collider-only actors are skipped unless Mesh collision, a tilemap, or a blocking volume supplies an implicit static body (`if (!rigid && !tilemap && !blocking && !meshCollision) return`). RigidBody-only actors spawn a body with **no shapes**. Mesh **Use Simple Collision** instantiates Model `simpleColliders` (or primitive built-ins). **Use Complex Collision** cooks the rest-pose visual triangle mesh (Play host extracts vertices/indices; the worker never receives the GLB). **No Collision** emits nothing from that MeshComponent. Extra `ColliderComponent` volumes still work. Dynamic / kinematic still use `RigidBodyComponent`. 2D worlds skip MeshComponent collision (sprites/tilemaps own 2D collision). Actors with `SpriteComponent` + `box2d` `ColliderComponent` rebuild the box from the current Sprite / Sprite Animation frame AABB each tick ([sprites.md](sprites.md)); leaving a sprite clip restores the Sprite default box. Circle / capsule / polygon stay authored. Graph-only spawns skip class ids that already exist as scene actors. `createPlayBootCoordinator` starts/resumes only after `loadPhysics` succeeds; existing host diagnostic handling reports startup failures. Script-load failures still report without blocking Play. `loadModels` posts Model JSON headers plus cooked complex meshes (same idea as `loadSprites`).

## Native body ownership and mutation

Havok bodies live independently of collider count. Each body owns its current collider shapes and optional compound container; colliders use canonical scaled geometry and one attachment-local rigid pose. `applyColliderChanges` prepares a body’s upserts/removals together, attaches the next topology to the existing body, then publishes IDs and retires detached resources. Failed preparation preserves the working set. Failed native attachment rolls back; a failed rollback is reported and its possibly attached resources remain owned until teardown.

The Babylon 9.20.0 adapter detaches the final shape through `HavokPlugin.setShape(body, null)` before clearing `body.shape`. The setter alone does not detach Havok geometry. The repository patch supplies `[0n]` for the plugin’s null native handle: Havok 1.3.14’s generated binding requires a one-element `HP_ShapeId` tuple, and the upstream scalar `0n` throws before detachment. Replacement reapplies authored mass while recalculating derived inertia, preserving velocities independently. Native bodies/controllers retire before their owned shapes. Malformed shape parameters, unsupported shape kinds, degenerate triangles, and unsupported shear are rejected before native allocation. Existing primitive scaling remains explicit: sphere/circle use the largest applicable axis, capsule/cylinder use the largest radial axis plus their axial length; this does not add ellipsoid geometry. The built-in complex sphere omits its zero-area pole faces. Mesh helpers are scoped to synchronous shape construction (Havok copies their data); query shapes retire in `finally`.

`teleportBody` immediately updates native pose without a render callback, normalizes valid quaternions, preserves linear/angular velocity by default, and accepts `{ velocity: "reset" }`. Teleports wake sleeping bodies. The pinned Havok binding updates pose immediately but leaves world query membership stale after a completed step. The isolated worker adapter refreshes membership by removing/reinserting the same native body handle, without a solver step or Babylon body removal; native result failures roll back through the same adapter. Body identity, callbacks, and native users remain attached to that handle. `setBodyTargetTransform` moves kinematic bodies through native targets. Dynamic simulation readback does not teleport. Requests made during native contact callbacks queue until stepping finishes; a query cannot observe queued changes from within that callback. Collider transactions retire prior actor-pair trigger bookkeeping; native contacts in the next step establish the replacement’s overlap lifetime.

Native fixtures exercise the packaged Havok solver in NullEngine, separately from browser/device rendering; the unresolved gates are recorded below. Collision preparation uses a fixed-size local TRS decomposition independently of vertex scaling. ColliderComponent shape assignments copy and freeze their geometry at construction/setVariable/variables.set; replace a shape to edit its content instead of mutating retained vertices in place. This gives the preparation cache a content identity without geometry scans during simulation.

## Components

| Component | Properties (core) |
| --- | --- |
| `RigidBodyComponent` | `motionType` (`static` \| `kinematic` \| `dynamic`), `mass`, `linearDamping`, `angularDamping`, `gravityScale` |
| `ColliderComponent` | `shape` (3D or 2D variant), `friction`, `restitution`, `isTrigger`, `layer`, `mask`, `renderInGame` (default **false**). Local `component.transform` is baked into `ColliderDesc` (translation, rotation, scaled sizes). |
| `MeshComponent` | `collisionMode` (`simple` \| `complex` \| `none`, default **simple**), `layer` (default `1`), `mask` (default `0xffffffff`). 3D only. Simple uses Model `simpleColliders` or primitive built-ins; complex uses the visual triangle mesh (rest-pose; skinned meshes do not animate the collider). Friction/restitution use ColliderComponent defaults (0.5 / 0). Backend collider IDs include actor, component, and shape identity; saved copies with repeated component IDs remain independent. |
| `BlockingVolumeComponent` | No authored properties. Place Actors **Physics → Blocking Volume** only (hidden from Add Component / Search). Editor: blue dotted unit box + `default.png` at the center. Play: helper hidden; static physics box from actor TRS. Not a navmesh input. |

Simulation needs **both** a rigid body and at least one collider on the same actor (tilemaps, **blocking volumes**, and **MeshComponent** collision that is not `none` are the exception: they create an implicit static body). That pairing is the authored workflow — not a Play blocker. Compile warnings:

| Case | Code | Severity |
| --- | --- | --- |
| Collider, no RigidBody, no Tilemap, no Blocking Volume, no Mesh collision | `physics.collider_without_body` | warning (one per collider) |
| RigidBody, no Collider, no Tilemap, no Blocking Volume, no Mesh collision | `physics.body_without_collider` | warning |
| Tilemap, Blocking Volume, or MeshComponent collision with or without RigidBody | none | OK |

`physicsActorDiagnostics` in `@babylonslate/physics` is the pure check (no React). Scene **Compiler Results** (Output Log tab) lists them; tap selects the actor. Prefab / Class Compiler Results merge the same warnings for `SerializedGraph.components` (`actorId` = Prefab Root). Diagnostics may carry `actorId` / `componentId`.

### Contact events

Actor-derived Class assets expose editable **Generate Hit Events** and **Generate Overlap Events** in Prefab Root's **Actor Defaults**. Both default to enabled, persist in the Class graph, and compile into runtime collision-dispatch flags. Object classes without an Actor ancestor do not show Actor Defaults or Prefab Origin. A disabled reset action does not disable or dim the editable checkbox.

Havok compound shapes share one actor-pair overlap lifetime: Begin Overlap fires when the first child-shape contact enters, and End Overlap waits for the last contact to leave. A MeshComponent plus ColliderComponent therefore does not repeat graph events as its shapes cross the same trigger on different ticks. An intersection already present when Play starts also emits Begin Overlap.

`pollContacts()` returns `{ kind: "hit" | "overlapBegin" | "overlapEnd", actorAId, actorBId, colliderAId?, colliderBId?, location, normal }` since the previous poll. Backend collider IDs encode `[actorGuid, componentGuid]` (explicit, blocking, and sprite colliders) or `[actorGuid, componentGuid, shapeId]` (MeshComponent). This isolates colliders from older saved duplicates without changing authored IDs, prefab references, or component parents. Contact dispatch restores the authored component ID for component-bound script events and accepts legacy contact identifiers. Software, Havok, and Rapier 2D populate them. **v1:** a blocking pair emits `hit` every poll while overlapping; if either collider `isTrigger`, the pair emits begin/end overlap only (no hit). Software AABB implements that rule; Havok maps blocking `COLLISION_STARTED` / `COLLISION_CONTINUED` to hit and trigger enter/exit to overlap (body-level contacts: overlap routing prefers the first trigger collider on each actor, then falls back to its first collider; multiple trigger components on one actor still share that binding); Rapier drains `EventQueue` collision events after `step` and keys pairs by collider handle. `RuntimeDriver` dispatches after `step` onto the matching actor entries bound to that collider id (see [scripting.md](scripting.md) Entry points). Actor flags `generateHitEvents` / `generateOverlapEvents` skip script dispatch only.

Spawn/attach creates bodies; destroy removes them (`PhysicsWorldSync` drops backend bodies when the actor leaves the live set). Bodies use the same composed world-space actor hierarchy as render snapshots. After `step`, body poses are converted through the inverse parent transform back into Actor-local TRS before `postPhysics`; a parented body therefore does not jump between local simulation and world rendering. Static and kinematic bodies copy the composed actor transform on resync; dynamic bodies keep the simulation transform. `addImpulse` is a no-op when the actor has no body. Tilemap chain colliders skip `collision: false` layers and missing guid/tileset payloads.

Graph **Set** of RigidBody / Collider catalog variables is not store-only. `setVariableOn` → `refreshComponent` → `PhysicsWorldSync.applyComponent` retunes the body and reconciles the actor's collider descriptors through one `applyColliderChanges` transaction. Native shape tuning remains available through `updateCollider`; geometry changes replace only the affected collider shape. Software, Rapier, and Havok implement the shared commands. Unit coverage lives in `packages/runtime/src/physics-sync.test.ts`, `packages/runtime/src/physics-sync-transactions.test.ts`, and `packages/physics/src/physics.test.ts`.

In 3D worlds, dynamic actors with `NavAgentComponent` retain physics position authority and gravity. Navigation supplies XZ steering while preserving vertical velocity; the crowd follows the resolved body position. Attaching a Behaviour Tree or stopping its movement task does not freeze a falling body. Navigation does not change `motionType` or `gravityScale`; kinematic bodies still require explicit movement. See [navigation.md](navigation.md#dynamic-rigid-bodies).

### Collider TRS bake

`bakeColliderLocal` (before `createCollider`, including sprite `box2d` rebuilds):

- **Sizes:** actor scale × component scale. Box half-extents per axis; sphere radius from max abs scale; circle from max abs XY; capsule radius from XZ (2D capsule from X), halfHeight from Y; polygon / chain / convex / mesh points scaled per axis.
- **Translation:** actor scale only (same as `composeActorComponentTransform` light/camera offsets).
- **Rotation:** component local quaternion on optional `ColliderDesc.rotation`. Havok applies it once as the attachment pose; Rapier uses `setRotation(quatToPlanarAngle)`; software AABB rotates the test box. Shear-free parent scaling is decomposed along the rotated component axes (including reflections); an oblique rotation under nonuniform scale that produces shear is rejected explicitly.

### Collision layers

Project Settings → **Physics** stores `settings.physics.collisionLayers` (`NamedListEditor`, default `["Default"]`, cap 32, same normalize pattern as sorting layers). Bit storage stays 32-bit for Havok membership/collide masks (`layer` = `1 << index`; Default → `1`). Collider Details: **Layer** is a single-bit Select; **Collides With** is a `FlagsField` of named bits only. No collision matrix in this slice.

### Editor / Play visuals

RigidBody-only actors use a camera-facing **`default.png` billboard** (Play `playHelperVisual`) — never a 0.25 cube. `ColliderComponent` is an `EditorSceneSync` **world visual** (opaque dashed segment meshes, `RENDERING_GROUP.world`, depth-tested). Editor always draws ColliderComponent dashes. MeshComponent simple/complex dashes follow session **Show Collisions** in Viewport Settings (default **off**; 2D worlds stay off). Play/export draws ColliderComponent dashes only when `renderInGame` is true (`meshKind` `collider:{json}`). Mesh collision dashes stay editor-only; Play uses console `showcollision` (`listDebugColliders()`, including capsules, convex hulls from generated/cone simple collision, Blocking Volume static boxes, and Mesh colliders). See [render.md](render.md) and [scene-editing.md](scene-editing.md).

### Shapes

- **3D:** box, sphere, capsule, cylinder (Havok `PhysicsShapeCylinder` when present, else a convex prism), convex hull, triangle mesh. Cone is not a first-class kind — it bakes to a convex (apex + base ring).
- **2D:** box, circle, capsule, polygon, chain (tilemap chunks emit merged chains via `tilemapChunkChains`)

Editor clicks are **mesh picks**, not physics. Collider dashes are unpickable in the Scene viewport; Mesh / Sprite / Tilemap stay the pick target when present. Physics-only actors pick via the origin proxy / default billboard. Havok/Rapier colliders exist in Play when the actor has authored `RigidBodyComponent` + `ColliderComponent`, a Tilemap, a Blocking Volume, or 3D **MeshComponent** collision (`collisionMode` ≠ `none` with resolved shapes). Details / Prefab Add Component lists box, sphere, and capsule (2D: box2d, circle, capsule2d). Cylinder is a first-class 3D physics kind for Model simple colliders and the primitive Mesh table (not a ColliderComponent Add-Component enum). **Simple collision** lives on the Model asset (`simpleColliders`: box, sphere, capsule, cylinder, cone, generated convex hull). Import of a static mesh (`skeletonGuid == null`) stamps one generated hull; a Skeleton leaves the list empty. **Add → Generated Collision** re-cooks the hull from the Model `source` chunk (disabled until that chunk is loaded). Generated hulls bake the glTF node hierarchy and Import Scale, then apply the same coordinate conversion as the model loader so collision aligns without manual rotation. Existing saved collider transforms are preserved; regenerate old hulls to use the corrected alignment. Degenerate meshes fall back to a bounds box named Generated Collision. **Use Complex Collision** uses the visual triangle mesh (rest-pose GLB or primitive tessellation); it does not animate with a skin. Existing Model files normalize missing `simpleColliders` to `[]` (no rewrite). 3D Empty scaffolds Kenney Mannequin Class and `actor-1` with a **kinematic** rigid body and a capsule (`radius` 0.5, `halfHeight` 1, Y offset `radius + halfHeight` so it sits on the feet origin). New Empty 3D projects only — existing scenes are not migrated.

## Scripting

Sync nodes (exec pin continues in the same tick): `physics.lineTrace`, `physics.sphereOverlap`, `physics.shapeSweep`, `physics.addImpulse`, `physics.moveCharacter`. Dragging off **Get Rigid Body** also Calls **Add Impulse** (`callComponentFunction` `addImpulse`) on that owner.

- **Line Trace** returns Hit Result plus exploded Hit, Location, Normal, Distance, and a live Actor reference. **Draw Debug** defaults on: misses draw a red line to End; hits draw a green line to the impact and a red circle aligned to its surface. Draws last one frame. **Actors To Ignore** accepts an Actor array (default empty); every collider on those actors is excluded before selecting the closest hit, so ignored actors cannot hide a target behind them. Software, Havok, and Rapier use the same exclusion contract (`LineTraceOptions.ignoreActorIds`); Havok restores temporarily masked shapes after each synchronous query.
- **Sphere Overlap Actors** keeps the `physics.sphereOverlap` id for existing graphs and returns a deterministic, de-duplicated live Actor array plus Int Count. Missing or destroyed actor ids are filtered.
- **Sphere Shape Sweep** exposes Radius and returns the same Hit Result / exploded query fields as Line Trace.
- Query misses return false, null vectors/Actor, and zero Distance rather than leaking backend ids or typed `undefined`. Radius defaults at or below zero emit `physics.radius`.
- Every query has an optional **Collision Channel** (default All). In 2D, authored `vec3` points use XY.

`moveCharacter` takes an Actor (defaults to `self`), lazily creates a character controller on that actor’s rigid body (`id` = actor guid, optional `offset` default 0.01), and applies the returned transform to the actor immediately so the next kinematic sync keeps it. Destroy follows the rigid body. No `CharacterControllerComponent` in this slice.

`ScriptHost` binds trace / overlap / sweep / impulse to the active backend and resolves returned actor ids through the live World before compiled graph code receives them.

## Determinism

Harness scenarios run on each backend where shapes overlap. Within-backend reproducibility is required. Do not require identical Havok vs Rapier **file** goldens — numeric drift between engines is expected.

`packages/runtime/src/physics-duplicate-identities.test.ts` exercises real Havok with five legacy duplicated dynamic boxes resting on a thin, Simple-only Ground, both with and without explicit box ColliderComponents. The Ground needs no RigidBodyComponent. `packages/runtime/src/collision-events.test.ts` covers native trigger entry/exit through compiled component-bound graphs, including initial intersection and compound mesh collision.

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


## Change-driven preparation and verification pickup

`PhysicsWorldSync` holds prepared state for the actual actor/component incarnation. It checks fixed-size authoring descriptors and TRS values before resolving model collision or scaling geometry; changed local poses and tuning reuse owned prepared geometry. Body readback uses one actor-ID index while World retains spawn ordering and first-match identity semantics. Readback gathers all native poses before resolving current parent-relative values. Physics uses the same authored actor-world composition as snapshot rendering: parent rotation composes with local rotation, and signed scales multiply per axis. A separate fixed-size TRS check rejects unsupported shear; it does not replace that shared representation with a new hierarchy decomposition. Rigid-body tuning changes through ordinary variable-map writes are detected by the same bounded descriptor boundary. Sprite clip commands hold weak Actor-keyed playback state, so a retired same-GUID actor cannot overwrite or clear its successor's playback. Sprite graph/behaviour-tree playback and character movement select the actor's world or SceneLayer physics owner, matching explicit teleport routing. Component and character commands require the actual prepared body owner; successor commands wait for synchronization instead of mutating the preceding incarnation. A nonphysics parent still affects dependent effective scale, and unsupported hierarchy shear fails before replacing native geometry. Static poses are submitted only when changed; kinematic targets retain their native motion contract.

Model collision installation compares exact collision descriptors once at `setModelContent`, copies mutable input into owned current sources, and retains unchanged source identities. The comparison includes simple collider content, import scale, and cooked complex geometry; it is not in the simulation loop. Source maps retain only the current installed generations. Geometry arrays assigned to ColliderComponent are copied/frozen at construction, `setVariable`, and direct `variables.set`, so edits replace the owned shape instead of mutating an old generation. Pose/tuning commands can reuse `prepareColliderShape` geometry without revalidating or copying vertices at each native transaction.

Local verification is deferred by user request (2026-09-22). No preparation speedup or operation counts are yet claimed. The runnable pre-implementation fixture is frozen at `de96b6d3`, branch `agent/engine-physics-dirty-c`, worktree `engine-physics-dirty-c`. Production is separate on `agent/engine-physics-dirty-c-impl`, worktree `engine-physics-dirty-c-impl` (cache/native-operation fixture checkpoint `ba33000f`, followed by reviewed parent-readback and incarnation repairs). Both are **unverified and unmerged**, with no PR. The native lifecycle release gates must pass before this delivery ships.

When checks resume, install frozen dependencies normally in each C worktree and keep machine admission/shared profile. Run the baseline before production to capture actual resolve/bake/serialization and actor lookup counts; expected failures are not observed failures until that run completes:

```powershell
$env:BL_TEST_PROFILE='shared'
pnpm --silent agent:wait local --script test '--' packages/runtime/src/physics-sync-preparation.test.ts
```

The baseline file has five cases: 4 versus 2,048 triangles over 20 moving-body ticks, and 128/512/2,048 body readbacks. The implementation adds a scaled-geometry counter so moving the old work into a different helper cannot satisfy the contract. After recording baseline results, run explicit production cases:

```powershell
pnpm --silent agent:wait local --script test '--' packages/runtime/src/physics-sync-preparation.test.ts packages/runtime/src/physics-sync-invalidation.test.ts
pnpm --silent agent:wait local --script test '--' packages/runtime/src/physics-sync-transactions.test.ts packages/runtime/src/physics-sync.test.ts packages/runtime/src/tilemap-physics.test.ts packages/runtime/src/physics-duplicate-identities.test.ts
pnpm --silent agent:wait local --script test '--' packages/runtime/src/anim-eval.test.ts packages/runtime/src/physics-teleport-runtime.test.ts
pnpm --silent agent:wait local --script test '--' packages/physics/src/collider-validation.test.ts packages/physics/src/physics.test.ts packages/object-model/src/world.test.ts packages/object-model/src/instantiate-scene.test.ts
```

The invalidation fixtures cover ordinary shape ownership/replacement, local pose, filter/material tuning, effective scale, nonphysics parents and shear failure, same-GUID component/actor replacement, pre-sync successor commands, mirrored-parent and nonuniform quarter-turn collision alignment with published visual snapshot transforms over multiple ticks, eligibility changes, and same/changed installed model generations. The preparation file also contains a real-Havok high-vertex fixture that records construction/helper counts and preparation/simulation/readback p50/p95/max timings. Still pending: all listed tests; executing those native counts and timing distributions and comparing the same fixture against a baseline checkout; SceneLayer sprite-clip and character owner-routing regressions; scoped physics/runtime/object-model typechecks and changed-file lint; independent review; relevant browser/player integration; and required PR CI/merge. No broad local suite is requested. Keep existing native trigger/teleport failures visible until their corrected cases pass.


## Native lifecycle verification pickup

The pinned worker adapter removes a body's native world membership before changing an attachment, while the original shape is still valid, then reinserts the same body handle. This retires the previous native contact pairs before old compound resources are released; Babylon body identity, reverse lookups and callbacks remain intact. A failed insertion stays tracked for the transaction's rollback. This boundary also refreshes immediate query membership for teleports. The trigger replacement regression reproduced a hang inside `HP_World_Step` after in-world compound replacement; the membership correction requires the native lifecycle/constraint/controller acceptance cases below.

Native world removal does not supply trigger-exit callbacks. Successful teleports and attachment/teleport rollbacks that refresh world membership explicitly end the previous actor-pair generation; subsequent native events establish current overlaps without stale contact counts.

Local checks were deferred at the user's request on 2026-09-22. Branch `agent/engine-physics-lifecycle-b`, implementation checkpoint `7177dda9`, is **unverified and unmerged**; no PR exists. Keep `BL_TEST_PROFILE=shared` and the machine-wide resource configuration unchanged when resuming. The physical A16 check was waived; local native/browser evidence is still required.

- Baseline `2bbb3ef8`: three real packaged-Havok lifecycle regressions failed (native removal, shape ownership, query helpers). Later null-detachment/resource tests ran, but the native transaction delivery has not passed as a whole.
- At `df12f40b`, immediate teleport changed native QTransform but the next ray missed. A controlled same-body world reinsert made the ray hit; the production adapter/result-check correction at `6c775fc7` has **not been tested**. Do not count mirrored node positions as query proof.
- The 60-second transaction selector timed out inside the trigger generation fixture. Its helper terminated its own child tree. Temporary per-case/stage diagnostics remain to locate the exact native operation; remove them after fixing the failure. A timeout is not a passed resource/trigger test.
- Packaged Havok is `1.3.14`, Babylon is patched `9.20.0`; packaged/vendor WASM SHA-256 is `026917766F534C156286F07975850978DABF17C42E742BBFAAEBBCB2215E4E11` (case-insensitive). The patch includes the required nullable shape tuple and checked native attachment/teleport results. Recompute the lockfile patch identity after combining other patch changes.

Resume the release-critical cases first, with bounded timeouts (PowerShell):

```powershell
$env:BL_TEST_PROFILE='shared'
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'ends retired trigger' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'teleports falling|keeps constraints|retains controller|defers contact' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 120 '--' packages/physics/src/havok-transactions.test.ts packages/physics/src/havok-lifecycle.test.ts
```

After those diagnoses pass, run these explicit affected files in separate admitted batches:

```powershell
pnpm --silent agent:wait local --script test '--' packages/physics/src/collider-validation.test.ts packages/runtime/src/physics-sync-transactions.test.ts packages/runtime/src/physics-teleport-runtime.test.ts
pnpm --silent agent:wait local --script test '--' packages/physics/src/physics.test.ts packages/physics/src/havok-v2.test.ts packages/physics/src/line-trace.test.ts packages/assets/src/mesh-collision.test.ts
pnpm --silent agent:wait local --script test '--' packages/runtime/src/physics-sync.test.ts packages/runtime/src/physics-duplicate-identities.test.ts packages/runtime/src/collision-events.test.ts packages/runtime/src/tilemap-physics.test.ts packages/runtime/src/script-host-physics-queries.test.ts
```

The first native batch covers 300 compound edit cycles, first/middle/final child removal, asymmetric scaled/mirrored local poses (native handedness cases are newly added and unexecuted), provisional cleanup/rollback failure, immediate queries, falling/sleeping velocity policy, native constraints/controllers, and contact-callback ordering. The affected consumer batches cover generated sphere validation, Rapier query/trigger behavior, source replacement, runtime gameplay teleport, SceneLayer routing, and existing mesh/sprite/tilemap collision behavior. All remain pending against the current correction. Also pending: scoped physics/runtime typechecks, lint on changed TypeScript, relevant browser/player integration, independent review, and required PR CI/merge. No full local suite is requested.
