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
| `PhysicsBackend` | Port: world lifecycle, bodies/colliders, `step(dt)`, `pollContacts()`, sync queries, impulses, partial world-axis `setBodyLinearVelocity` for dynamic bodies, live `updateBody` / `applyColliderChanges` |
| `PhysicsWorldKind` | `"3d"` \| `"2d"` — one kind per scene |
| `createPhysicsBackend` | Lazy factory; dynamic-imports only the needed engine |
| `bakeColliderLocal` | Actor × component scale into shape sizes; scaled local translation; local rotation on `ColliderDesc` |
| `physicsActorDiagnostics` | Body/collider pairing warnings and `physics.movement_conflict` setup warnings; implicit collision sources exempt from ordinary pairing warnings |
| Shape / body / hit types | Shared descriptors shaped primarily around Havok |

Depends on `@babylonslate/core` at the type layer plus `@babylonjs/core` Physics V2 and `@babylonjs/havok` for 3D. No React, no Capacitor, no editor Babylon packages (gui/loaders/inspector). `@babylonslate/runtime` still must not import Babylon.

The optional `getBodyImpulseResponse(bodyId, impulse, point)` query returns the predicted world linear/angular velocity change and world centre of mass without changing the body. Havok uses native collider inertia (including principal-axis rotation and mass); software uses its unit-inertia model. [Water buoyancy](render.md#water) uses this to solve its support forces together while leaving collision response to the native solver.

## Backends

Havok also implements the optional `createSphereSweep(radius)` port for [Cable Component](render.md#cable-component). It owns one native sphere and reusable query results, excludes triggers and checks initial penetration before sweeping. Radius must be finite and positive. `SphereSweepQuery.sweep` returns a borrowed `HitResult` (including its vectors), valid until the next sweep: distance is sphere-center travel, location is the collider surface, and initial overlap has distance zero. Dispose queries when no longer needed; backend shutdown also disposes them. A disposed query returns a miss.

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

Change Scene retires departing actors before replacing the main physics backend when the target dimension differs. The target Havok/Rapier backend is ready before its actors begin; loading failures stay visible and cancellation disposes any late native allocation. The overlay world survives this replacement. Software-only/headless sessions make the equivalent dimension change synchronously.

## Tick integration

Order (from P3): `gameInstance` → `actors` → `components` → **`physics`** → `postPhysics`.

1. Script phases may call sync queries on the live backend.
2. `physics` phase: `backend.step(dt)`, then write body transforms back to Actors, then `pollContacts()` (see Contact events).
3. `RuntimeDriver` times script phases and the physics phase separately into snapshot/`stats` `scriptMs` and `physicsMs`; snapshot publish time is reported separately as `stats` `publishMs`.

### Per-tick transform work

`PhysicsWorldSync.step` runs for the main world and, while layers are ready, for the SceneLayer overlay world. Each tick:

- **Before stepping**, it composes world poses once for physics participants (eligible actors with a RigidBody, Movement, Collider, Mesh, Blocking Volume, Tilemap, Water Buoyancy, or enabled Landscape / Dynamic Runtime Mesh collision) and their ancestors. This pass is the tick's validation boundary: a parent cycle or unsupported shear throws here, before any native change.
- **Body membership** scans each eligible actor's components once, including Movement ownership; the Movement collider descriptor reuses that result. Only a static with a dynamic or kinematic ancestor scans again, to decide whether that ancestor [hosts](#collidable-static-children-of-simulated-bodies) its shapes. Collider-set, rigid-body, mesh-collision-source and static-pose descriptors are written into reusable scratch and copied only when they change; direct variable-map writes and in-place vector edits still invalidate them.
- **Movement motors** then run as the `step` hook. They move their own bodies' actors from this composition without recomposing it. Their transition events can run scripts, and the hook reports when they did. After such a script writes a pose through `teleportActor` or `moveCharacter`, later motors in the hook resolve their own chains at call time instead (see below).
- **Water** (3D only): `WaterWorld.update` does no transform work while no enabled water surface exists; a Landscape or removal volume alone does not trigger it. With water, it composes only water, removal-volume, Landscape and Water Buoyancy actors plus their ancestors, using the same last-wins guid lookup as a whole-world pass. Any duplicate actor guid in the world, or a parent cycle on those chains, falls back to the whole-world pass. Script `sampleWater` queries evaluate separately at call time (see below).
- **Readback** skips static bodies (see [Static bodies follow their actor](#static-bodies-follow-their-actor)) and copies other unparented bodies' native poses without composition. A parented body resolves only its ancestor chain: dynamic and kinematic bodies contribute their post-step native pose with composed scale, nonphysics and static actors compose under their resolved parent, and chains without such a body reuse the pre-step composition. A body → nonphysics → body chain therefore places the middle actor from the upper body's post-step pose. Readback does not repeat cycle or shear validation, because only Movement has changed its inputs since the pre-step pass, and those actors are bodies. Unless the hook returns `false` (no scripts ran), readback instead recomposes and revalidates the whole world with post-step body poses, because scripts may have changed poses, parents or physics membership.

#### Static bodies follow their actor

Explicit static rigid bodies and implicit Mesh, Tilemap, Blocking Volume, Landscape and Dynamic Runtime Mesh bodies are driven one way, from the actor to physics, in both the main and SceneLayer overlay worlds:

- Readback never writes a static pose. Authored depth and X/Y rotation survive in 2D worlds (Rapier simulates only the plane), and authored quaternions are not normalized; native bodies still use the unit rotation.
- A static child of a moving dynamic or kinematic parent keeps its local pose, so its world pose follows the parent. Previously readback rewrote that local pose to hold the old world pose. Its solid shapes ride on the parent's body instead of a body of its own (see [Collidable static children of simulated bodies](#collidable-static-children-of-simulated-bodies)); only its triggers, or a static without shapes such as a joint anchor, keep a following static body.
- The pre-step pass teleports a static body only when its composed pose changed: once per tick while it or an ancestor moves, never in a steady scene. `teleportActor` on a static body uses the same check.
- A teleported static trigger keeps its overlaps (see [Contact events](#contact-events)), so a trigger carried by a moving parent does not repeat Begin Overlap.
- Following is a velocity-less teleport: it does not carry bodies resting on the static (use a kinematic body for a moving platform).
- Dynamic and kinematic readback are unchanged. Results remain deterministic within a build, but differ from builds before this change.

`packages/runtime/src/physics-static-follow.test.ts` covers these rules through `PhysicsWorldSync`: 2D depth and tilt on Rapier, a non-normalized quaternion on Havok, a shape-less static child of a falling parent, zero teleports in a steady Havok static scene, and one teleport per tick with a single Begin Overlap for a carried trigger on Havok, Rapier and software.

#### Collidable static children of simulated bodies

A collidable static actor (explicit static RigidBody with a solid collider, or implicit Mesh, Tilemap, Blocking Volume, Landscape or Dynamic Runtime Mesh collision) whose ancestor chain contains a dynamic or kinematic body, including a Movement character, becomes part of the **nearest** such ancestor's body, like a Unity child collider of a Rigidbody. Static and nonphysics actors in between do not host. It applies to the main and SceneLayer overlay worlds and to Havok, Rapier and software.

- **Shapes:** its non-trigger colliders become child shapes of the host's compound. They are baked as for its own body (its composed world scale, component transforms), then posed by the local transforms from the host down to it, composed under the host's world scale. They move and collide as one object with the host and never collide with it, so an overlapping child no longer pushes its parent upward. It has no static body of its own and is never teleported.
- **Triggers:** trigger colliders stay on a separate following static body, which keeps the teleport overlap persistence above. Havok reports trigger events per body, so a trigger shape inside the host would lose the child's own overlap events. That body never overlaps the child's own hosted shapes: software and Rapier skip pairs of shapes with the same owner, and still report the child's triggers against the host's other shapes. Havok cannot tell the child's shapes from the host's, so it reports no overlaps between a hosted actor's trigger body and its host at all.
- **Mass:** the host keeps its authored mass. Havok derives center of mass and inertia from the whole compound, including hosted shapes. Rapier gives hosted shapes zero density, so the host's mass, center of mass and inertia stay what its authored mass and its own colliders give it (each own collider still adds its default density mass, as before). The software backend ignores shape mass.
- **Events and queries:** software and Rapier resolve contacts and queries per shape, so hits, overlaps, traces and sphere overlaps against a hosted shape name the child actor and its collider, whose ID decodes to the child's component for component-bound script events. Havok works per body: contacts name the host and its own collider, so the child receives no hit events while hosted, and casts report the compound's root shape, so traces, sweeps and sphere overlaps name the host too. `ignoreActorIds` skips a hosted child's shapes in every backend's traces and sweeps; on Havok, ignoring the host also skips the shapes it hosts, and sphere overlaps test whole-body bounds. Collision channels classify hosted shapes by the host's motion type.
- **Invalidation:** hosts are reassigned every pre-step pass, before bodies change, so attach, detach, reparent, spawn, destroy, a changed local transform or collider setting, and a host becoming static, losing its body or gaining one all take effect before the next simulation step. A child that loses its host gets its own following static body at its current world pose. Hosted collider IDs carry the host's guid, so shapes never reuse a live ID while moving between bodies. Pose writes (`teleportActor`), collider `applyComponent` and Mesh refreshes on a hosted actor rebuild its host's compound at call time; motion-type changes re-host at the next step. The host's collision descriptor includes each child's host-relative pose, which ignores the host's world pose, so a moving host never rebuilds its compound. A child that moves relative to its host (an animated wheel or held prop) rebuilds the compound on each tick it moves (Havok builds a new container), but its overlaps stay open (see [Contact events](#contact-events)).
- **Joints:** a hosted actor has no body, so a constraint that it owns or targets attaches to its host's body instead: its anchor, axes and fixed frame are moved into the host's frame by its pose on the host, and the joint is recreated when that pose changes or the actor is unhosted. A joint between a hosted actor and its own host would connect one body to itself and is skipped.

`packages/runtime/src/physics-hosted-shapes.test.ts` covers a dynamic parent resting on its overlapping Mesh child without climbing or rebuilding (software and Havok), a kinematic parent's child shape pushing a dynamic body on Havok, call-time pose writes and detaching, restoring the child's own body when the parent becomes static or loses its RigidBody, contact attribution on software, Rapier and Havok, a hosted child's trigger that does not overlap its own shapes and an overlap that stays open while a child moves on its host (software, Rapier and Havok), Rapier keeping the host's mass, and a Havok joint owned by a hosted actor that its host carries.

These reductions keep per-tick actor transforms (`stringifyWorldSnapshot(createWorldSnapshot(world))`) identical for acyclic hierarchies. `packages/runtime/src/physics-tick-composition.test.ts` counts transform reads of unrelated actors: 2,048 decorations in a Landscape-only scene (20 ticks plus one water query) fall from 43,008 reads to 0, and from 614,400 to 0 over 300 ticks with water and two floats. Post-step readback beside 2,048 render meshes falls from 6,144 reads per tick to 0, with unparented bodies and with a parented chain. A one-off, uncommitted comparison on Windows / Node 24.19 (software backend, 2,048 render meshes, three quarters of them parented, and 64 bodies; 100 measured ticks) observed step p50 of 8.5–9.5 → 4.8 ms without water and 13.4–15.2 → 5.7–7.8 ms with water. These are diagnostic desktop measurements, not device budgets.

### Call-time pose writes and queries

Scripts run between steps, after readback, navigation and earlier script writes have moved actors, so call-time paths never read the last pre-step composition. They resolve only the actors they touch, with the pre-step pass's rules: first-match parent lookup through `World.findActor`, destroyed parents end a chain, and a parent cycle or unsupported shear on that chain throws. Cycles and shear elsewhere in the world fail the next step, as before.

| Path | Composition per call |
| --- | --- |
| `teleportActor` (Set Actor Location / Rotation / Scale / Transform, Add Actor World Offset) | None for an actor that neither owns nor can create a body (lights, cameras, props without collision). Otherwise the actor's own ancestor chain, then colliders and the native teleport; a static body is teleported only when its pose changed. A [hosted](#collidable-static-children-of-simulated-bodies) actor instead rebuilds its host's compound from its own chain. Descendant bodies are not teleported: static and kinematic ones follow at the next step, and dynamic ones keep their simulated pose. |
| `applyComponent` for collider classes and Movement | The owner's chain; for a hosted owner, its chain and its host's compound. |
| `applyComponent` for a constraint | Scans and indexes the world to find joints; only connected endpoints compose their chains for anchor scale. |
| Mesh or Ragdoll `refreshComponent` (`syncActor`) | The owner's chain; it creates, retires or updates only that body, and reconciles joints only when the body was created. Other actors whose ragdolls changed meanwhile get their bodies at the next step. |
| `moveCharacter` | The actor's chain, for lazy body creation and to convert the controller's world result against the parent's current pose. |
| `sampleWater` | Water surfaces (only the selected water actor's, when one is given) and removal-volume / Landscape cutters, with ancestors, in a query state separate from the step's. Buoyant actors are not composed. Later queries in the same tick reuse that evaluation while nothing it read changed (`WaterWorld.query`). The step still evaluates its own water at its own clock. |
| Project Cursor To Scene | The camera's chain for the ray; the trace itself composes nothing. Like Line Trace, it sees bodies as of the last step plus call-time pose writes and component refreshes: actors spawned, destroyed, attached or reparented earlier in the tick, and static or kinematic bodies whose ancestors moved, reach the ray after the next step. It no longer runs a whole pre-step pass per call. |

Movement motors are the exception: they run as `step`'s hook after its pre-step composition and reuse it while it is current. A transition event script can run between motors; once it writes a pose through `teleportActor` (including a body-less parent) or `moveCharacter`, each later motor in that hook composes its own chain, so it starts from the written pose and follows a moved parent instead of restoring the pre-step pose. `movement.test.ts` covers both cases through Play scripts. The composition test file drives the call-time paths through Play scripts beside 512 render meshes: Set Actor Location on a light and Add Actor World Offset on a body read none of their transforms (previously every call recomposed all of them), and Sample Water reads neither them nor a buoyant raft.

Play (in-process and the game worker) constructs a `SoftwarePhysicsBackend`, then `RuntimeDriver.loadPhysics()` loads Havok or Rapier before simulation starts and re-syncs already-spawned bodies. When SceneLayer documents are available, their separate Rapier world must also initialize before the swap; failure releases the newly loaded engines. Without those documents, no overlay actors can be created and the empty overlay world stays in software. `preferSoftwarePhysics` skips the swap for explicit software tests. Loading remains deferred until Play, so opening the editor does not fetch physics WASM.

The Play `load` control message carries `sceneAssetGuid`, optional authored `scene` (`SerializedScene`), `physicsWorld`, `gravity`, and `havokWasmUrl`. The editor resolves its vendored `havok/HavokPhysics.wasm` through the deployment base (for example `/BabylonSlate/havok/HavokPhysics.wasm` on Pages) and sends an absolute worker URL. Preview Build resolves its copy relative to the player. An explicit WASM URL must load successfully; Node's package-file lookup is only used when no URL was supplied. Details / Actor Prefab Add Component lists include `RigidBodyComponent` and `ColliderComponent`.

Play instantiates the open `SerializedScene` on `RuntimeDriver.realizePlayWorld()` (after scripts load so Begin Play binds on spawn). Demo actors are not seeded when a scene payload is present. `PhysicsWorldSync` then creates bodies for authored `RigidBodyComponent` **plus** `ColliderComponent`, a static body plus merged chain colliders for `TilemapComponent` (see [tilemaps.md](tilemaps.md)), a **static** body plus box collider for `BlockingVolumeComponent` (half-extents `|scale|/2`, world rotation from actor TRS; no RigidBody required), and **MeshComponent** collision in 3D worlds (`collisionMode` ≠ `none` with resolved shapes). Collider-only actors are skipped unless Mesh collision, enabled Landscape collision, a tilemap, or a blocking volume supplies an implicit static body. RigidBody-only actors spawn a body with **no shapes**. Mesh **Use Simple Collision** instantiates Model `simpleColliders` (or primitive built-ins). **Use Complex Collision** cooks the rest-pose visual triangle mesh on the host (the worker never receives the GLB); see [Complex Collision cooking](#complex-collision-cooking). **No Collision** emits nothing from that MeshComponent. Extra `ColliderComponent` volumes still work. Dynamic / kinematic still use `RigidBodyComponent`. 2D worlds skip MeshComponent collision (sprites/tilemaps own 2D collision). Actors with `SpriteComponent` + `box2d` `ColliderComponent` rebuild the box from the current Sprite / Sprite Animation frame AABB each tick ([sprites.md](sprites.md)); leaving a sprite clip restores the Sprite default box. Circle / capsule / polygon stay authored. Graph-only spawns skip class ids that already exist as scene actors. `createPlayBootCoordinator` starts/resumes only after `loadPhysics` succeeds; existing host diagnostic handling reports startup failures. Script-load failures still report without blocking Play. `loadModels` posts Model JSON headers plus cooked complex meshes (same idea as `loadSprites`).

### Complex Collision cooking

- **Format:** a cooked mesh is a `CollisionTriangleMesh` (`@babylonslate/core`): flat `Float32Array` xyz `positions` plus triangle-list `indices` (`Uint16Array` when every vertex fits, else `Uint32Array`). Typed arrays structured-clone as one memcpy and are transferable. The `mesh` `ColliderShape` uses the same arrays, and Havok receives them without per-vertex objects. Authored `ColliderComponent` mesh rows stay object-per-vertex JSON and are packed when parsed. Asset-cache estimates count the typed bytes.
- **Demand scan:** `complexCollisionModelGuids(documents)` (`@babylonslate/assets`) selects Models named by `MeshComponent` rows with `collisionMode: "complex"` in Scene / SceneLayer actors and Class prefab / compiled-script `components`. Editor Play source preparation and the exported player scan each prepared closure and cook only those Models, so Models used with Simple or No Collision are never parsed for collision. Classes are scanned, so actors spawned at runtime from them get their colliders up front.
- **Once per Play:** editor preparation caches each cooked Model per revision (`model-cpu:collision-v2`); Play installs those prepared meshes and never cooks again at session start. The exported player cooks each needed Model as a separate cached `export-complex-collision` representation of the prepared scope.
- **On-demand fallback:** when a Complex Collision MeshComponent names a Model with no installed mesh (for example a script switching **Collision Mode** or the Model), `PhysicsWorldSync` reports the miss and the runtime sends `requestComplexCollision` once per Model. The host cooks it from the loaded source (editor: the shared cache entry) and answers with `loadComplexCollision`. Until the answer arrives that MeshComponent contributes no collider; the next physics sync then rebuilds the actor body. Answers persist for the session beside later `loadModels` replacements. If the Model source is not loaded or has no triangles, the host answers `unavailable` and the runtime emits one `physics.complex_collision_unavailable` warning diagnostic per Model; preload the Model or use Simple Collision.

Enabled **Landscape Collisions** supplies an implicit static body and triangle-mesh collider in 3D worlds. `LandscapeComponent.collisionsEnabled` defaults to `false`. Runtime physics and editor Drop share the authored heightfield triangulation; sculpting, resolution, dimensions, and transforms update the collision surface. Material displacement does not change collision geometry. Runtime preparation caches geometry across unchanged frames and paint/material edits; disabling or removing the Landscape retires its collider. 2D physics ignores Landscape collisions.

## Native body ownership and mutation

Havok bodies live independently of collider count. Each body owns its current collider shapes and optional compound container; colliders use canonical scaled geometry and one attachment-local rigid pose. `applyColliderChanges` prepares a body’s upserts/removals together, attaches the next topology to the existing body, then publishes IDs and retires detached resources. Failed preparation preserves the working set. Failed native attachment rolls back; a failed rollback is reported and its possibly attached resources remain owned until teardown.

The Babylon 9.29.0 adapter detaches the final shape through `HavokPlugin.setShape(body, null)` before clearing `body.shape`. The setter alone does not detach Havok geometry. The repository patch supplies `[0n]` for the plugin’s null native handle: Havok 1.3.14’s generated binding requires a one-element `HP_ShapeId` tuple, and the upstream scalar `0n` throws before detachment. Replacement reapplies authored mass while recalculating derived inertia, preserving velocities independently. Native bodies/controllers retire before their owned shapes. Malformed shape parameters, unsupported shape kinds, degenerate triangles, and unsupported shear are rejected before native allocation. Existing primitive scaling remains explicit: sphere/circle use the largest applicable axis, capsule/cylinder use the largest radial axis plus their axial length; this does not add ellipsoid geometry. The built-in complex sphere omits its zero-area pole faces. Mesh helpers are scoped to synchronous shape construction (Havok copies their data); query shapes retire in `finally`.

`teleportBody` immediately updates native pose without a render callback, normalizes valid quaternions, preserves linear/angular velocity by default, and accepts `{ velocity: "reset" }`. Teleports wake sleeping bodies. The pinned Havok binding updates pose immediately but leaves world query membership stale after a completed step. The isolated worker adapter refreshes membership by removing/reinserting the same native body handle, without a solver step or Babylon body removal; native result failures roll back through the same adapter. Body identity, callbacks, and native users remain attached to that handle. `setBodyTargetTransform` moves kinematic bodies through native targets. Dynamic simulation readback does not teleport. Requests made during native contact callbacks queue until stepping finishes; a query cannot observe queued changes from within that callback. Collider transactions retire prior actor-pair trigger bookkeeping; native contacts in the next step establish the replacement’s overlap lifetime. Teleports keep overlaps that the next step re-reports (see [Native lifecycle verification](#native-lifecycle-verification)).

Native fixtures exercise the packaged Havok solver in NullEngine, separately from browser/device rendering; the unresolved gates are recorded below. Collision preparation uses a fixed-size local TRS decomposition independently of vertex scaling. ColliderComponent shape assignments copy and freeze their geometry at construction/setVariable/variables.set; replace a shape to edit its content instead of mutating retained vertices in place. This gives the preparation cache a content identity without geometry scans during simulation.

## Components

### Movement component

Add **General → Movement** to an actor in a 3D or 2D world scene. It owns an upright capsule centered on the actor, with dimensions in world units. The default radius is 0.4 and total height is 1.8. Place the actor above a collision surface; world +Y is up. Ground movement uses XZ in 3D and X in 2D, with Y reserved for jumping and falling. SceneLayers do not support Movement.

Use one Movement per actor. It supplies its own kinematic body and sole collision capsule, so an additional Rigid Body is unnecessary. Rigid Body, Nav Agent, Ragdoll, Water Buoyancy, or multiple Movement components on the same actor prevent Movement simulation. While Movement owns the actor, mesh collision and authored Collider components do not add shapes to its body. Actor/component scale and the component's local transform do not resize or offset the capsule; adjust Radius and Height directly. Spawn without penetrating another collider. Moving-platform carry is not guaranteed.

Compiler Results reports incompatible component combinations before Play. The Class/Prefab Inspector omits Movement's ineffective local Transform controls and explains graph setup beside Enabled. Sprite animation frames, visual transforms and actor scale do not recreate the Movement capsule or restart its trigger overlaps.

- Movement is controlled through graphs. Connect a 2D Input Axis event to **Convert Input**, then pass Direction to **Set Movement Input**; send zero when the axis is released. Connect an Input Action press to **Jump**. A 1D axis can supply X with a zero Y value.
- **Convert Input** maps a Vec2 through the radial **Dead Zone** (default 0.1), **Input Scale** (1), **Input Space** (World or Actor), and **Input Yaw** plus its extra yaw argument. It returns a world direction; 2D uses X only. Actor space follows the actor's heading, without tilting the movement plane. Graph Input Space strings ignore surrounding whitespace and letter case.
- **Set Movement Input** stores world-space input until changed. **Add Movement Input** contributes to the next physics tick and then clears. Their sum is clamped to unit length, retaining analog strength while preventing faster diagonal movement.
- **Set Velocity** replaces world velocity; **Add Velocity** adds a world velocity change. **Stop Immediately** clears velocity, input and buffered jumping. Disabling Movement clears velocity and requests while retaining a stationary capsule.
- **Jump** buffers a request. **Coyote Time** allows a jump shortly after walking off an edge; **Jump Buffer Time** retains an early press until landing. Both default to 0.1 seconds. A successful jump consumes the coyote allowance, so repeated calls cannot create an extra midair jump.

| Setting | Default | Effect |
| --- | --- | --- |
| Max Speed | 5 | Maximum commanded horizontal speed, world units/s |
| Acceleration / Braking | 30 / 40 | Approach the desired speed / slow when input is released, world units/s² |
| Air Control | 0.35 | Fraction of horizontal steering available in the air |
| Gravity Scale / Max Fall Speed | 1 / 40 | Scale scene gravity / cap downward speed |
| Jump Speed | 6 | Upward launch speed, world units/s |
| Max Slope Angle | 50° | Steepest surface considered walkable |
| Ground Snap Distance | 0.1 | Distance used to maintain contact with nearby ground |

Get-only **Velocity**, horizontal **Speed**, **Is Grounded**, **Is In Air**, and **Is Moving** expose current state. Is Moving uses horizontal speed above 0.01 world units/s. Component events report **Started**, **Stopped**, **Jumped**, **Left Ground**, and **Landed**, each with the resulting Velocity and Speed. The same runtime path serves Play and exported players. Movement currently provides ground travel and jumping; flying modes and automatic stair climbing are outside its contract.

Havok and Rapier apply the slope limit through their native character controllers. Ground snapping only follows nearby supporting ground after a grounded frame; it does not add a downward impulse when leaving a ledge. Havok uses a short capsule cast and Rapier uses native snapping, so their exact edge response may differ. The software test/fallback backend uses swept bounding boxes and cannot represent slopes. Ordinary movement preserves trigger overlap lifetimes; explicit teleports follow the physics teleport contract, which also keeps overlaps that remain after the teleport.

Each solve begins at the actor's current authored world pose, including changes inherited from its parent. This inherited repositioning does not become motor velocity and is not swept movement or moving-platform carry. Havok installs the inherited pose before its motor target so the native speed limit cannot clip parent updates; Rapier retains its previous-to-final kinematic target. Both preserve native body membership and trigger overlap continuity. A failed Havok pose update restores the prior body/controller pose; failed rollback prevents further simulation of that body until teardown. Motor updates visit registered Movement components, including paused motors when they resume, without scanning unrelated actors. Graph commands and simulation read live component settings.

### Constraints and ragdolls

**Add Component → Physics → Physics Constraint** connects the owner's body to another actor. Choose **Target Actor** from the searchable scene picker; it includes explicit Rigid Bodies and implicit Mesh, Blocking Volume, or Tilemap bodies. Set a target after placing a Class, or use the component's **Set Connected Actor** graph function. An empty/missing target waits for a body to become available. Duplicating a connected selection remaps its internal targets to the copied actors.

| Constraint | 3D Havok | 2D Rapier | Controls |
| --- | --- | --- | --- |
| Fixed | Yes | Yes | Local frame rotations define the locked relative orientation. |
| Ball Socket / Pivot | Yes | Yes | Anchors stay together; relative rotation is free. |
| Hinge | Yes | Yes | One rotation axis, optional minimum/maximum angles in degrees. 2D rotates around Z. |
| Distance | Yes | No | Exact world-space separation; not a maximum-length rope. |

Local Anchor and Target Local Anchor are actor-local points, including actor scale. Axes and frame rotations use the corresponding body's local orientation; the component transform does not move the joint. Hinge reference axes establish zero angle and must not be parallel to the hinge axis. **Enabled** creates/releases the joint; **Collide Connected** defaults off. At least one body should be dynamic for visible simulation. Bodies can be assembled into chains or mechanical/character rigs using ordinary actors and constraints.

**Add Component → Physics → Ragdoll** provides skeletal ragdolls for 3D Model actors. Leave **Bone Names** empty for the complete skinned or hierarchy rig, or list a connected subtree using exact bone names. Enable the component in Details or set **Enabled** from a graph. Activation captures the current animated pose; it does not reset the character to a bind pose. **Total Mass**, **Radius**, damping, material/filter settings, and **Angular Limit** tune the automatic bodies. Radius is in world units and is capped for short segments. Each bone uses a capsule toward its first non-coincident child, or a sphere for a leaf, with limited ball joints between bones. This is an automatic general rig; use a smaller Bone Names subtree for detailed models.

- One enabled Ragdoll component per actor, one connected skeleton, up to 128 selected bones. Actor scale must be positive; bone world scale must be uniform and nonzero. Reflected GLB coordinate conversion is supported. Ragdolls are unavailable in 2D and SceneLayers.
- While active, bone bodies replace the actor's ordinary collision and inherit its linear/angular velocity field. The actor follows the simulated root's translation; physics owns bone rotations. Existing **Add Impulse** affects the full assembly; impulses issued immediately after enabling are retained during pose capture and applied once on activation. Collision queries return the owning actor.
- Unselected channels hold their captured pose while the selected subtree simulates. Disabling releases the assembly, restores ordinary collision, and resumes animation at its current gameplay time. It does not implement a get-up animation or an animation/physics blend.
- Activation failures are reported without silently substituting software physics. Model/property changes cancel previous capture generations. Despawn, stop, and backend replacement release owned joints before bodies; late capture replies cannot revive old actors.

The worker owns all constraints and ragdoll bodies. `PhysicsBackend.createConstraint` validates and prepares replacements before retiring an existing joint; body removal retires attached joints. `RagdollPhysics` prepares and owns its articulated assembly. Reliable bridge capture replies carry current world bone poses to the worker; pose commands carry simulation results back. The renderer applies them after its animation pass and before bone attachments. Software physics explicitly lacks constraint solving; only the temporary pre-native boot phase defers their creation.

`PhysicsBackend.getBodyVelocity` returns an owned snapshot of world-space linear velocity, angular velocity in radians/second, and center of mass. `setBodyAngularVelocity` sets a dynamic body's angular velocity (Z only in 2D). Ragdoll activation uses each collider's mass center to inherit the actor's rigid velocity field, and whole-assembly impulses act at those centers without introducing torque at bone pivots.

Constraint reconciliation reuses identity and scalar descriptor storage on unchanged ticks. It still detects direct variable-map writes and in-place edits to anchors or frames; native joints are rebuilt only when their authored settings, body owners, or effective scales change. Invalid edits preserve the last usable joint.

Ragdoll synchronization scans current component membership but resolves transforms only for enabled ragdolls and their ancestors. With no active assembly, post-step ragdoll readback returns before traversing the actor list. No persistent transform cache hides script movement, reparenting, scale edits, or same-ID replacements.

The renderer retains pose lookup tables and matrix/vector scratch storage per controller/session. Unlinked bone locals are written before refreshing the skeleton, so descendant matrices are updated in a batch, including unselected descendants. Linked bones reuse already updated parent worlds during the pose pass. Inverse bind matrices, animation handoff, native collision settings, and solver stepping remain unchanged. Prefer a connected **Bone Names** subtree when a detailed character does not need every bone simulated; the existing 128-bone limit remains in force.

Focused performance fixtures live in `ragdoll-sync-performance.test.ts`, `physics-constraints.test.ts`, and `ragdoll-pose.test.ts`. They exercise 2,048 unrelated actors, 128 stable native joints, and 16/64-bone chains, with deterministic bounds on unrelated transform reads and hierarchy work. Their p50/p95 timings are diagnostic desktop measurements, not device frame-rate guarantees or timing thresholds in CI.

Observed on Windows / Node 24 / Babylon 9.20, with the shared single-worker profile, 20 warm-up iterations and 100 measured iterations (milliseconds, before → after):

| Isolated work | p50 | p95 |
| --- | --- | --- |
| Ragdoll sync/readback, all disabled | 4.091 → 0.173 | 17.818 → 0.454 |
| Ragdoll sync/readback, one active two-bone rig | 5.839 → 0.684 | 20.375 → 1.441 |
| Reconcile 128 unchanged native constraints | 0.602 → 0.185 | 0.970 → 0.640 |
| Present a 64-bone unlinked chain | 0.609 → 0.081 | 0.744 → 0.202 |

The actor fixtures count unrelated transform reads (409,600 → 0 across 100 ticks). The 64-bone presentation fixture includes an unselected tip: absolute-matrix visits fall from 6,239 to 65 per update. Timings exclude native simulation in the reconciliation fixtures and exclude rendering/GPU work in the NullEngine presentation fixture; they do not establish a mobile frame budget.

| Component | Properties (core) |
| --- | --- |
| `RigidBodyComponent` | `motionType` (`static` \| `kinematic` \| `dynamic`), `mass`, `linearDamping`, `angularDamping`, `gravityScale`. Details clamps Mass to at least 0.001 and hides Mass / Gravity Scale / Damping on a static body; Havok and Rapier both floor a non-positive runtime mass at 1e-6. |
| `ColliderComponent` | `shape` (3D or 2D variant), `friction`, `restitution`, `isTrigger`, `layer`, `mask`, `renderInGame` (default **false**). Local `component.transform` is baked into `ColliderDesc` (translation, rotation, scaled sizes). |
| `MeshComponent` | `collisionMode` (`simple` \| `complex` \| `none`; new components default **none**, so mesh collision is opt-in and never adds a hidden shape beside explicit ColliderComponents; a legacy document missing the field still parses as `simple`), `layer` (default `1`), `mask` (default `0xffffffff`). 3D only. Simple uses Model `simpleColliders` or primitive built-ins; complex uses the visual triangle mesh (rest-pose; skinned meshes do not animate the collider). Friction/restitution use ColliderComponent defaults (0.5 / 0). Backend collider IDs include actor, component, and shape identity; saved copies with repeated component IDs remain independent. |
| `BlockingVolumeComponent` | No authored properties. Place Actors **Physics → Blocking Volume** only (hidden from Add Component / Search). Editor: blue dotted unit box + `default.png` at the center. Play: helper hidden; static physics box from actor TRS. Not a navmesh input. |
| `LandscapeComponent` | `collisionsEnabled` (default **false**), edited in Landscape mode → Landscape Settings. 3D triangle mesh from `width`, `depth`, `subdivisions`, and `heights`; friction 0.5, restitution 0. |

Simulation needs **both** a rigid body and at least one collider on the same actor (tilemaps, **blocking volumes**, enabled **Landscape Collisions**, and **MeshComponent** collision that is not `none` are the exception: they create an implicit static body). That pairing is the authored workflow — not a Play blocker. Compile warnings:

| Case | Code | Severity |
| --- | --- | --- |
| Collider, no RigidBody, no Tilemap, no Blocking Volume, no Mesh collision, no enabled Landscape collision | `physics.collider_without_body` | warning (one per collider) |
| RigidBody, no Collider, no Tilemap, no Blocking Volume, no Mesh collision, no enabled Landscape collision | `physics.body_without_collider` | warning |
| Tilemap, Blocking Volume, MeshComponent collision, or enabled Landscape collision with or without RigidBody | none | OK |

`physicsActorDiagnostics` in `@babylonslate/physics` is the pure check (no React). Scene **Compiler Results** (Output Log tab) lists them; tap selects the actor. Prefab / Class Compiler Results merge the same warnings for `SerializedGraph.components` (`actorId` = Prefab Root). Diagnostics may carry `actorId` / `componentId`.

### Contact events

Actor-derived Class assets expose editable **Generate Hit Events** and **Generate Overlap Events** in Prefab Root's **Actor Defaults**. Both default to enabled, persist in the Class graph, and compile into runtime collision-dispatch flags. Object classes without an Actor ancestor do not show Actor Defaults or Prefab Origin. A disabled reset action does not disable or dim the editable checkbox.

Havok compound shapes share one actor-pair overlap lifetime: Begin Overlap fires when the first child-shape contact enters, and End Overlap waits for the last contact to leave. A MeshComponent plus ColliderComponent therefore does not repeat graph events as its shapes cross the same trigger on different ticks. An intersection already present when Play starts also emits Begin Overlap. A teleport does not restart an overlap that remains after it, on any backend: Havok keeps the actor pair open until the next step re-reports it and ends it after that step otherwise, while software and Rapier keep their pair state across teleports. A collider change that keeps the collider IDs and each collider's trigger flag, layer, mask and owner (a new pose or shape, such as a hosted child moving on its host) keeps overlaps open the same way: Havok refreshes the body's actor pairs, Rapier the replaced colliders' pairs, and the next step confirms or ends them; software pairs are keyed by collider ID. Adding or removing colliders, or changing that contact policy, still ends and re-establishes the body's Havok overlaps and the changed colliders' Rapier overlaps.

`pollContacts()` returns `{ kind: "hit" | "overlapBegin" | "overlapEnd", actorAId, actorBId, colliderAId?, colliderBId?, location, normal }` since the previous poll. Backend collider IDs encode `[actorGuid, componentGuid]` (explicit, blocking, and sprite colliders) or `[actorGuid, componentGuid, shapeId]` (MeshComponent). This isolates colliders from older saved duplicates without changing authored IDs, prefab references, or component parents. Contact dispatch restores the authored component ID for component-bound script events and accepts legacy contact identifiers. Software, Havok, and Rapier 2D populate them. **v1:** a blocking pair emits `hit` every poll while overlapping; if either collider `isTrigger`, the pair emits begin/end overlap only (no hit). Software AABB implements that rule; Havok maps blocking `COLLISION_STARTED` / `COLLISION_CONTINUED` to hit and trigger enter/exit to overlap (body-level contacts: overlap routing prefers the first trigger collider on each actor, then falls back to its first collider; multiple trigger components on one actor still share that binding); Rapier drains `EventQueue` collision events after `step` and keys pairs by collider handle. A collider's optional `actorId` names the owner of a shape hosted on another actor's body; software and Rapier report that actor (and a host-qualified collider ID that still decodes to its component), while Havok's body-level contacts name the body's actor and route only to its own colliders (see [hosted shapes](#collidable-static-children-of-simulated-bodies)). `RuntimeDriver` dispatches after `step` onto the matching actor entries bound to that collider id (see [scripting.md](scripting.md) Entry points). Actor flags `generateHitEvents` / `generateOverlapEvents` skip script dispatch only.

Spawn/attach creates bodies; destroy removes them (`PhysicsWorldSync` drops backend bodies when the actor leaves the live set). Bodies use the same composed world-space actor hierarchy as render snapshots. Script parent writes cannot form a cycle (see Attach Actor in [scripting.md](scripting.md)), and scene, streamed-scene and SceneLayer loads break cycles in their data before physics first composes those actors (see [object-model.md](object-model.md#actor-parent-hierarchy)); a cycle that still forms another way makes physics composition throw and fails that tick. Physics resolves a duplicated parent guid to its first-spawned live actor, as snapshots, the crowd and the other runtime passes now do; water alone keeps its last-wins lookup. After `step`, dynamic and kinematic body poses are converted through the inverse post-step parent transform back into Actor-local TRS before `postPhysics` (see [Per-tick transform work](#per-tick-transform-work)); a parented body therefore does not jump between local simulation and world rendering. Static bodies are not read back. Static and kinematic bodies copy the composed actor transform on resync; dynamic bodies keep the simulation transform. `addImpulse` is a no-op when the actor has no body. Tilemap chain colliders skip `collision: false` layers and missing guid/tileset payloads.

Graph **Set** of RigidBody / Collider catalog variables is not store-only. `setVariableOn` → `refreshComponent` → `PhysicsWorldSync.applyComponent` retunes the body and reconciles the actor's collider descriptors through one `applyColliderChanges` transaction, resolving only the owner's ancestor chain. Mesh and Ragdoll refreshes call `syncActor` instead, which can also create or retire that actor's body. Havok keeps the native shape for trigger, material and filter changes; geometry changes replace only the affected collider shape. Software, Rapier, and Havok implement the shared commands. Unit coverage lives in `packages/runtime/src/physics-sync.test.ts`, `packages/runtime/src/physics-sync-transactions.test.ts`, and `packages/physics/src/physics.test.ts`.

In 3D worlds, dynamic actors with `NavAgentComponent` retain physics position authority and gravity. Navigation supplies XZ steering while preserving vertical velocity; the crowd follows the resolved body position. Attaching a Behaviour Tree or stopping its movement task does not freeze a falling body. Navigation does not change `motionType` or `gravityScale`; kinematic bodies still require explicit movement. See [navigation.md](navigation.md#dynamic-rigid-bodies).

### Collider TRS bake

`bakeColliderLocal` (before `createCollider`, including sprite `box2d` rebuilds):

- **Sizes:** actor scale × component scale. Box half-extents per axis; sphere radius from max abs scale; circle from max abs XY; capsule radius from XZ (2D capsule from X), halfHeight from Y; polygon / chain / convex / mesh points scaled per axis.
- **Translation:** actor scale only (same as `composeActorComponentTransform` light/camera offsets).
- **Rotation:** component local quaternion on optional `ColliderDesc.rotation`. Havok applies it once as the attachment pose; Rapier uses `setRotation(quatToPlanarAngle)`; software AABB rotates the test box. Shear-free parent scaling is decomposed along the rotated component axes (including reflections); an oblique rotation under nonuniform scale that produces shear is rejected explicitly.

### Collision layers

Project Settings → **Physics** stores `settings.physics.collisionLayers` (`NamedListEditor`, default `["Default"]`, cap 32, same normalize pattern as sorting layers). Bit storage stays 32-bit for Havok membership/collide masks (`layer` = `1 << index`; Default → `1`). Collider Details: **Layer** is a single-bit Select; **Collides With** is a `FlagsField` of named bits only. No collision matrix in this slice.

Rapier contact and sensor-pair hooks preserve the same 32-bit membership/mask contract, including layers above bit 15. Both colliders must admit the other layer before collision response or contact/overlap events occur; the software fallback uses the same pair rule.

### Editor / Play visuals

RigidBody-only actors use a camera-facing **`default.png` billboard** (Play `playHelperVisual`) — never a 0.25 cube. `ColliderComponent` is an `EditorSceneSync` **world visual** (opaque dashed segment meshes, `RENDERING_GROUP.world`, depth-tested). Editor always draws ColliderComponent dashes. MeshComponent simple/complex dashes follow session **Show Collisions** in Viewport Settings (default **off**; 2D worlds stay off). Play/export draws ColliderComponent dashes only when `renderInGame` is true (`meshKind` `collider:{json}`). Mesh collision dashes stay editor-only; Play uses console `showcollision` (`listDebugColliders()`, including capsules, convex hulls from generated/cone simple collision, Blocking Volume static boxes, and Mesh colliders). See [render.md](render.md) and [scene-editing.md](scene-editing.md).

### Shapes

- **3D:** box, sphere, capsule, cylinder (Havok `PhysicsShapeCylinder` when present, else a convex prism), convex hull, triangle mesh. Cone is not a first-class kind — it bakes to a convex (apex + base ring).
- **2D:** box, circle, capsule, polygon, chain (tilemap chunks emit merged chains via `tilemapChunkChains`)

Editor clicks are **mesh picks**, not physics. Collider dashes are unpickable in the Scene viewport; Mesh / Sprite / Tilemap stay the pick target when present. Physics-only actors pick via the origin proxy / default billboard. Havok/Rapier colliders exist in Play when the actor has authored `RigidBodyComponent` + `ColliderComponent`, a Tilemap, a Blocking Volume, or 3D **MeshComponent** collision (`collisionMode` ≠ `none` with resolved shapes). Details / Prefab Shape Kind lists box, sphere, capsule, and cylinder (2D: box2d, circle, capsule2d). A newly added ColliderComponent, and a Shape Kind switch, wrap the actor's primitive MeshComponent (built-in primitive sizes × the Mesh component scale; Model, sprite and tilemap visuals keep the 0.5 defaults). Cylinder is also a 3D physics kind for Model simple colliders and the primitive Mesh table. **Simple collision** lives on the Model asset (`simpleColliders`: box, sphere, capsule, cylinder, cone, generated convex hull). Import of a static mesh (`skeletonGuid == null`) stamps one generated hull; a Skeleton leaves the list empty. **Add → Generated Collision** re-cooks the hull from the Model `source` chunk (disabled until that chunk is loaded). Generated hulls bake the glTF node hierarchy and Import Scale, then apply the same coordinate conversion as the model loader so collision aligns without manual rotation. Existing saved collider transforms are preserved; regenerate old hulls to use the corrected alignment. Degenerate meshes fall back to a bounds box named Generated Collision. **Use Complex Collision** uses the visual triangle mesh (rest-pose GLB or primitive tessellation); it does not animate with a skin. Existing Model files normalize missing `simpleColliders` to `[]` (no rewrite). 3D Empty scaffolds Kenney Mannequin Class and `actor-1` with a **kinematic** rigid body and a capsule (`radius` 0.5, `halfHeight` 1, Y offset `radius + halfHeight` so it sits on the feet origin). New Empty 3D projects only — existing scenes are not migrated.

## Scripting

Line Trace normals follow the contacted surface in Rapier 2D, including walls and slopes. The software fallback reports the entry face of its approximate AABB; a trace starting strictly inside that box has distance zero and no entry normal (the zero vector).

Sync nodes (exec pin continues in the same tick): `physics.lineTrace`, `physics.sphereOverlap`, `physics.shapeSweep`, `physics.addImpulse`, `physics.moveCharacter`. Dragging off **Get Rigid Body** also Calls **Add Impulse** (`callComponentFunction` `addImpulse`) on that owner.

- **Line Trace** returns Hit Result plus exploded Hit, Location, Normal, Distance, and a live Actor reference. **Draw Debug** defaults on: misses draw a red line to End; hits draw a green line to the impact and a red circle aligned to its surface. Draws last one frame. **Actors To Ignore** accepts an Actor array (default empty); every collider on those actors is excluded before selecting the closest hit, so ignored actors cannot hide a target behind them. Software, Havok, and Rapier use the same exclusion contract (`LineTraceOptions.ignoreActorIds`); Havok restores temporarily masked shapes after each synchronous query.
- **Sphere Overlap Actors** keeps the `physics.sphereOverlap` id for existing graphs and returns a deterministic, de-duplicated live Actor array plus Int Count. Missing or destroyed actor ids are filtered.
- **Sphere Shape Sweep** exposes Radius and returns the same Hit Result / exploded query fields as Line Trace.
- Query misses return false, null vectors/Actor, and zero Distance rather than leaking backend ids or typed `undefined`. Radius defaults at or below zero emit `physics.radius`.
- Every query has an optional **Collision Channel** (default All). In 2D, authored `vec3` points use XY.
- Channels filter live physics candidates before choosing a hit: **WorldStatic** selects static bodies, **WorldDynamic** selects dynamic/kinematic bodies, **Pawn** selects actors owned by a valid Movement component, and **Visibility** excludes triggers. **All** retains the existing backend defaults. These are built-in query categories, not configurable per-channel collision responses. Havok overlap remains a body-AABB approximation; Visibility excludes trigger-only bodies from that approximation.

`moveCharacter` takes an Actor (defaults to `self`), lazily creates a character controller on that actor’s rigid body (`id` = actor guid, optional `offset` default 0.01), and applies the returned transform to the actor immediately so the next kinematic sync keeps it. A parented actor's local transform is computed against its parent's pose at call time, so a parent moved earlier in the same event is respected. Destroy follows the rigid body. No `CharacterControllerComponent` in this slice.

`ScriptHost` binds trace / overlap / sweep / impulse to the active backend and resolves returned actor ids through the live World before compiled graph code receives them.

## Determinism

Within-build reproducibility is required: the same build, backend and inputs produce the same actor transforms. The test-kit `runDeterministicScenario` golden covers scripted World ticks without physics; there is no per-backend physics harness. Physics coverage comes from focused backend and runtime tests (for example the software and Rapier cases in `packages/physics/src/physics.test.ts`). Do not require identical Havok vs Rapier **file** goldens — numeric drift between engines is expected. Runtime work reductions must leave per-tick `stringifyWorldSnapshot(createWorldSnapshot(world))` unchanged for acyclic hierarchies.

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


## Change-driven preparation

`PhysicsWorldSync` holds prepared state for the actual actor/component incarnation. It checks fixed-size authoring descriptors and TRS values before resolving model collision or scaling geometry; changed local poses and tuning reuse owned prepared geometry. Body readback uses one actor-ID index while World retains spawn ordering and first-match identity semantics. Readback gathers the native poses of dynamic and kinematic bodies (static bodies are skipped) before resolving current parent-relative values. Physics uses the same actor-world composition as snapshot rendering, which matches the editor's authored matrices (`local × parentWorld`, see [object-model.md](object-model.md#actor-parent-hierarchy)): parent scale applies in the parent's frame, so a quarter-turned child permutes nonuniform parent scale onto its own axes, and a mirrored parent reflects across its own axis. A separate fixed-size TRS check rejects unsupported shear before composition. Readback inverts a body's native pose through the same matrices with the actor's composed world scale, so a resting body under a mirrored or nonuniform parent keeps its local rotation. Rigid-body tuning changes through ordinary variable-map writes are detected by the same bounded descriptor boundary. Sprite clip commands hold weak Actor-keyed playback state, so a retired same-GUID actor cannot overwrite or clear its successor's playback. Sprite graph/behaviour-tree playback and character movement select the actor's world or SceneLayer physics owner, matching explicit teleport routing. Component and character commands require the actual prepared body owner; successor commands wait for synchronization instead of mutating the preceding incarnation. A nonphysics parent still affects dependent effective scale, and unsupported hierarchy shear fails before replacing native geometry. Static poses are submitted only when changed; kinematic targets retain their native motion contract.

Model collision installation compares exact collision descriptors once at `setModelContent`, copies mutable input into owned current sources, and retains unchanged source identities. The comparison includes simple collider content and import scale; cooked complex geometry is compared element-wise against the installed typed arrays. It is not in the simulation loop. Source maps retain only the current installed generations. Geometry arrays assigned to ColliderComponent are copied/frozen at construction, `setVariable`, and direct `variables.set`, so edits replace the owned shape instead of mutating an old generation. Pose/tuning commands can reuse `prepareColliderShape` geometry without revalidating or copying vertices at each native transaction.

Status: delivered through [PR #663](https://github.com/hideoutgames/BabylonSlate/pull/663), merged into `main` on 2026-09-23 after its required PR Verify run (static, unit and all seven e2e shards) passed. The frozen pre-implementation fixture (`de96b6d3`, `agent/engine-physics-dirty-c`) remains the historical baseline. `physics-sync-preparation.test.ts` counts resolve/bake/scaled-geometry/serialization work over 4 versus 2,048 triangles and actor lookups for 128/512/2,048 body readbacks.

The invalidation fixtures cover ordinary shape ownership/replacement, local pose, filter/material tuning, effective scale, nonphysics parents and shear failure, same-GUID component/actor replacement, pre-sync successor commands, mirrored-parent and nonuniform quarter-turn collision alignment with published visual snapshot transforms over multiple ticks, eligibility changes, and same/changed installed model generations. The preparation file also contains a real-Havok high-vertex fixture that records construction/helper counts and preparation/simulation/readback p50/p95/max timings. They also cover post-step readback through a body → nonphysics → body chain and body membership changes from direct variable-map writes.


## Native lifecycle verification

The pinned worker adapter removes a body's native world membership before changing an attachment, while the original shape is still valid, then reinserts the same body handle. This retires the previous native contact pairs before old compound resources are released; Babylon body identity, reverse lookups and callbacks remain intact. A failed insertion stays tracked for the transaction's rollback. This boundary also refreshes immediate query membership for teleports. The trigger replacement regression reproduced a hang inside `HP_World_Step` after in-world compound replacement; the membership correction requires the native lifecycle/constraint/controller acceptance cases below.

Native world removal does not supply trigger-exit callbacks. Attachment changes and attachment/teleport rollbacks that refresh world membership explicitly end the previous actor-pair generation; subsequent native events establish current overlaps without stale contact counts. A successful teleport instead resets the actor's pair contact counts and keeps the pairs open: native re-entry in the next step confirms a pair without another Begin Overlap, and pairs not re-entered end after that step.

Branch `agent/engine-physics-lifecycle-b` (implementation checkpoint `7177dda9`) was delivered through [PR #663](https://github.com/hideoutgames/BabylonSlate/pull/663), merged into `main` on 2026-09-23 after its required PR Verify run passed. The physical A16 check was waived. The history below records the local diagnosis before that merge.

- Baseline `2bbb3ef8`: three real packaged-Havok lifecycle regressions failed (native removal, shape ownership, query helpers). Later null-detachment/resource tests ran, but the native transaction delivery has not passed as a whole.
- At `df12f40b`, immediate teleport changed native QTransform but the next ray missed. A controlled same-body world reinsert made the ray hit; the production adapter/result-check correction at `6c775fc7` has **not been tested**. Do not count mirrored node positions as query proof.
- The 60-second transaction selector timed out inside the trigger generation fixture. Native-boundary diagnostics located the hang in `HP_World_Step` after compound replacement. Membership correction `82361386` allowed the test to finish, exposing a missing teleport exit event; `6158defc` corrects generation retirement. Temporary diagnostic logging has been removed. The follow-up selector was queued without execution, so the native acceptance gate remains open.
- Packaged Havok is `1.3.14`, Babylon is patched `9.29.0`; packaged/vendor WASM SHA-256 is `026917766F534C156286F07975850978DABF17C42E742BBFAAEBBCB2215E4E11` (case-insensitive). The patch includes the required nullable shape tuple and checked native attachment/teleport results. Recompute the lockfile patch identity after combining other patch changes.

Focused release-critical selections, with bounded timeouts (PowerShell):

```powershell
$env:BL_TEST_PROFILE='shared'
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'ends retired trigger' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'teleports falling|keeps constraints|retains controller|defers contact' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 120 '--' packages/physics/src/havok-transactions.test.ts packages/physics/src/havok-lifecycle.test.ts
```

Affected consumer files, in separate admitted batches:

```powershell
pnpm --silent agent:wait local --script test '--' packages/physics/src/collider-validation.test.ts packages/runtime/src/physics-sync-transactions.test.ts packages/runtime/src/physics-teleport-runtime.test.ts
pnpm --silent agent:wait local --script test '--' packages/physics/src/physics.test.ts packages/physics/src/havok-v2.test.ts packages/physics/src/line-trace.test.ts packages/assets/src/mesh-collision.test.ts
pnpm --silent agent:wait local --script test '--' packages/runtime/src/physics-sync.test.ts packages/runtime/src/physics-duplicate-identities.test.ts packages/runtime/src/collision-events.test.ts packages/runtime/src/tilemap-physics.test.ts packages/runtime/src/script-host-physics-queries.test.ts
```

The first native batch covers 300 compound edit cycles, first/middle/final child removal, asymmetric scaled/mirrored local poses (including native handedness cases), provisional cleanup/rollback failure, immediate queries, falling/sleeping velocity policy, native constraints/controllers, and contact-callback ordering. The affected consumer batches cover generated sphere validation, Rapier query/trigger behavior, source replacement, runtime gameplay teleport, SceneLayer routing, and existing mesh/sprite/tilemap collision behavior.

Authored simple-collider factories copy identity TRS arrays for each collider. Editing a source collider must not mutate another component or the defaults used by future primitives. Software queries compose the body rigid pose with collider-local pose before computing their existing conservative bounds.

Make Transform now supplies unit scale when its scale input is unauthored, so graph-created physics actors have a valid default transform. Explicit authored scales remain unchanged, including zero values that physics rejects as degenerate.

Collider property parsing defaults to native geometry validation. Inspector rows explicitly select the authoring mode so empty point clouds and zero-sized draft primitives remain editable; the runtime and native backends still reject those geometries. Primitive sizes (half extents, radius, half height, height) are unsigned: parsing reads a negative value as its absolute value, and Details clamps edits to at least 0.001. Editor collider dashes also parse in authoring mode, so a saved zero-sized collider cannot fail the scene load.

`DynamicRuntimeMeshComponent` optionally contributes its runtime triangles to the owning actor's 3D body. **Enable Collision** defaults off; an actor without a Rigid Body gets an implicit static body. Edits are committed at the next physics step and reuse the prepared shape while positions, topology and component/ancestor transforms are unchanged. Normals, UVs and materials do not recook collision. Clear, disable, destruction and scene teardown remove the collider. See [Dynamic Runtime Mesh](render.md#dynamic-runtime-mesh) for its component-bound API and update costs.
