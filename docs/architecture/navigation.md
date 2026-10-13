# Navigation (P11)

Shared surface for navmesh bake and worker queries (engineplan §14.2). Implementation: `@babylonslate/navigation`. Recast wasm is allowed; no React, no Babylon, no `@recast-navigation/babylon`.

Play hosts supply `sceneNavmeshBytes` on the load control/runtime options, keyed by canonical scene asset guid. Change Scene selects the target mesh before actor Begin Play, resets departing obstacles/costs, and clears navigation for an unbaked target. The `loadNavMesh` control imports the current scene's mesh before Play realizes: with `bytes` it records them for that scene, and without `bytes` it imports the entry the load control's `sceneNavmeshBytes` already holds. The editor omits `bytes` when it passed the same mesh in the load catalog, so the startup mesh crosses to the worker once; otherwise it sends one private buffer that the host transfers. Runtime Stop disposes its navigation session, including in-process Play.

Tile-cache obstacles, 2D bake input, scripting nodes, and crowd `MoveTo` are in (`p11-nav-blockers-2d`). **P19** (`p19-nav-leftovers`) wires Auto Bake On Save, bake-bounds collect, and cost volumes (Detour poly area + query-filter costs). Unwalkable tile-cache carve is unchanged. §18: `packages/runtime/src/p11-acceptance.test.ts` (including a dynamic box that **closes** an open route after MoveTo is running) plus `e2e/p11-ai.spec.ts` (3D bake, then Play).

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `navigation` | Recast generate / `exportNavMesh` / `importNavMesh` / tile-cache `exportTileCache` round-trip, `NavigationBackend`, 2D XY↔XZ remap, facing-from-velocity, Scene `navmesh` chunk helpers, Recast `DebugDrawerUtils` primitives, static blocker meshes | React, Babylon, Capacitor, `@recast-navigation/babylon` |
| `apps/editor` | Mesh / blocker / 2D collect, bake worker host, blocking bake modal, NavMesh + NavMesh Blocker Place Actors, Recast settings Details | Capacitor |
| `render` | Main-thread collect for bake; editor debug overlay mesh from Recast primitives | React, Capacitor |
| `runtime` | Import scene `navmesh` chunk; `NavAgentComponent` → `addAgent`; dynamic unwalkable `NavMeshBlockerComponent` → `addObstacle`; cost blockers → `applyCostVolume`; `stepCrowd` into the snapshot; BT `MoveTo` | Babylon, DOM |
| `scripting-nodes` | FindPathTo / MoveTo / StopMovement / IsPathValid / GetClosestNavigablePoint / GetRandomPointInRadius / obstacle add/remove (`ctx.*`, no Recast import) | React, Babylon, Capacitor, `@babylonslate/navigation` |

Do **not** use Babylon `RecastJSPlugin`. `@recast-navigation/core` + `generators` own the byte format. `@recast-navigation/babylon` is not a published npm package; editor debug draw uses Recast `DebugDrawerUtils` in `navigation` plus a Babylon filled mesh with edge outlines in `render`.

## Package API (`p11-navigation` + `p11-nav-blockers-2d`)

- `generateNavMesh({ positions, indices, settings? })` → bytes. `settings.supportDynamicObstacles` selects Recast **tile cache** (`generateTileCache` + `exportTileCache`, 32-cell tiles, up to 128 obstacles) wrapped with magic `BSNT`; otherwise `settings.tiled` selects a tiled navmesh (`generateTiledNavMesh`, 32-cell tiles) and the default is solo, both exported with `exportNavMesh()`. A tile-cache bake whose stacked walkable layers overflow its tile budget (4 per tile) retries with twice the budget, up to 32, then fails. Call `initNavigation()` / generate before import. Play **never** generates.
- `createNavigationBackend()`: `importNavMesh` (detects `BSNT` vs solo; decodes before releasing the live mesh, so a failed import keeps it), `findPath` (empty when the goal cannot be reached; never a partial path), `closestPoint`, `randomPointInRadius`, `addObstacle` / `removeObstacle` (tile-cache **unwalkable** carve), `applyCostVolume` / `removeCostVolume` (Detour polygon areas + query/crowd filter costs; does **not** `addObstacle`), `addAgent` / `updateAgent` / `removeAgent` / `stopAgent` / `agentPosition` / `agentVelocity` / `setAgentTarget`, `stepCrowd` (moves added agents and flushes tile-cache updates).
- Obstacles and cost volumes take the volume center as `pose` and its full extent as `size`; a cylinder uses its X/Z size as diameters (an obstacle carves the larger one) and Y as height. A box obstacle takes an optional yaw about +Y. `addObstacle` returns `""` when nothing was carved: a solo or tiled navmesh, or a tile cache holding its 128 obstacles. `addAgent` returns `""` when the crowd holds its 128 agents; the crowd places new agents and projects move targets within the same reach as path queries. A cost volume prices the polygons its box overlaps, reaching 0.5 above and below the box for surfaces Recast places a few cells off the floor. Graph **Set** of Nav Agent Radius / Height / Max Speed / Max Acceleration calls `updateAgent` on the live Recast crowd (`CrowdAgent.updateParameters`). Graph / actor **Move To** (`setNavAgentTarget`) calls `addAgent` when that actor is not in the crowd yet, so Begin Play Move To is not a no-op (`ActorRealization.realize` fires Begin Play before the batch `registerNavAgents`).
- Cost volumes retain independent prices; overlapping polygons use the highest price, regardless of insertion order. Up to 62 distinct prices share Detour's available area IDs (equal prices share an ID). Adding a 63rd distinct price throws before changing existing navigation costs.
- Crowd steps with a fixed dt and the same navmesh bytes are identical across two backends in unit tests; if that ever fails, record agent pose into the P8 trace instead of recomputing.
- Idle crowd ticks retain their native query and skip tile-cache updates. Obstacle adds and removes queue in the tile cache and apply as one batch before the next query or crowd operation (a backlog of 8 requests flushes early, so one update never has more tiles to rebuild than Detour's 64); cost-volume edits restore and restamp one batch before the next query or crowd operation, with unchanged volumes skipped. `dispose()` releases the crowd, query, navmesh, tile cache, allocator, compressor and mesh process; repeated disposal is safe, and a later import can reuse the backend.
- `worldToRecast` / `recastToWorld`: 2D world `(x, y, _)` ↔ Recast `(x, 0, y)`. Property-tested. No other code touches Recast axes. Runtime remaps queries and crowd pose when `physicsWorld` is `2d`.
- `facingYawFromVelocity`: Recast XZ yaw (`atan2(x, z)`), keep previous yaw below a min-length guard.
- `syncAgentPosition` writes the corrected position; Detour moves the corridor there during the next `stepCrowd`.
- `syncAgentPosition(id, position)` projects a resolved physics position onto the crowd corridor without resetting its destination or accumulated velocity.
- `solidBlockerMesh` / `recastWalkableQuadFromXy` / `recastWallsFromXyChains`: bake solids (center pose, full size, cylinder X/Z diameters). Walls are thick boxes so Recast can voxelise them.
- `navmeshChunk` / `extraChunksWithNavmesh` / `NAVMESH_CHUNK_ID = "navmesh"`. Pass the chunk as `extraChunks` on Scene save; `extraChunksFromDecoded` already preserves it. Readers load the bytes by chunk id (`readAssetChunk(path, NAVMESH_CHUNK_ID)`). Not a Content Browser type.

Recast settings (`NavMeshSettings`) are data in Recast's own units: cell size/height in world units and walkable slope in degrees; walkable height and climb in cell heights; walkable radius, edge length and simplification error in cells; region areas as a side length in cells; detail sample distance in cells and its max error in cell heights. The generators apply the cell-size conversions.

## Editor host

- Place Actors **NavMesh** spawns an Actor with `NavMeshComponent` (Recast numbers, solo/tiled enum, support-dynamic-obstacles, **Auto Bake On Save** default off, **Bake Bounds** plus min/max). Not an Add Component row. Viewport Settings **Show Navmesh** (`scene.settings.showNavmesh`, default off) owns the overlay; the NavMesh has no overlay setting.
- Place Actors **NavMesh Blocker** spawns an Actor with `NavMeshBlockerComponent` (`dynamic` default false, `kind` box/cylinder, `area` unwalkable/cost, **Cost** number when Area is Cost, default 10, min > 1). Scale is the blocker size (a cylinder's X/Z scale are diameters). Editor draws an amber dotted volume plus `default.png` at the center. Not Add Component / Search.
- Details **Bake NavMesh** opens a non-dismissable modal on a painted frame, collects geometry, runs `generateNavMesh` in a dedicated bake worker (tile cache when Support Dynamic Obstacles is on, otherwise tiled or solo per **Generate**), writes the Scene `navmesh` chunk with the Scene body as it is when the bake finishes. Bakes run one at a time; a Save auto-bake waits for a running Bake. A failed bake keeps the modal open with the Recast error and a Close control (Save still continues).
- Save with Auto Bake On Save awaits `flushNavBakeForSave()` (same `startBake` / `NavBakeDialog` as Bake). Export does **not** auto-bake. Open Scene workspaces stay mounted and keep a collector; closing the Scene tab unregisters collect until a Scene remounts.
- 3D collect: `MeshComponent` world meshes — origin-root / glTF **visual children**, triangle winding reversed for Recast +Y; skip editor pick proxies — plus static unwalkable blockers transformed by the actor's world transform (the full parent chain). Dynamic / cost blockers are skipped at bake. When Bake Bounds is on, meshes, tilemap chains, and static blockers whose AABB misses the box are dropped.
- 2D collect: Recast XZ walkable quad padded around actor origins and every collected wall (clipped to the bounds box XY when enabled), `ColliderComponent` 2D shapes placed and sized as 2D physics places them (actor world transform through the parent chain, actor × component scale, planar rotation) whose baked XY extent meets the box (circles and capsules stand on the walk plane; capsules bake as stadiums; chain and polygon edges become walls along each edge), tilemap collision chains (`tilemapCollisionChains` / `navBakeTilemapChains`) that intersect the box XY, and static blockers in-box by XY, turned by their Z rotation. MeshComponent XY verts are not fed to Recast.
- Debug overlay: Recast tris lifted ~0.04 on +Y, translucent green fill, darker green edge outlines, unpickable. Viewport **Show Navmesh** drives the editor overlay; when on, NavMesh Blocker volumes also draw at the world pose the bake carves them (`blockerWorldMatrix`, through the parent chain). The editor reads the stored chunk when the overlay turns on and again only after an asset registry change; scene edits redraw the blockers over those bytes, and only when a blocker, the bake (compared by content, since a save rereads the chunk into a new array) or the physics world actually changed: an unchanged resync keeps the drawn meshes, because adding and disposing scene meshes and materials marks renderer readiness dirty and re-probes every shader variant. Play console `shownav` reuses the same overlay (blockers included; Blocking Volumes are not nav input and stay off this overlay).
- Play reads the Scene chunk (`readPlayNavmeshBytes`) and posts `loadNavMesh` **before** `realizePlayWorld`. `NavAgentComponent` registers `addAgent` (batch after Begin Play, or lazily on the first Move To); dynamic **unwalkable** blockers register `addObstacle` from their world volume (an upright box or cylinder keeps its shape and yaw; a tilted one carves its world AABB box); **cost** blockers (static and dynamic) call `applyCostVolume` with their world AABB. A blocker's obstacle or cost volume is removed when the blocker is destroyed, loses its component or changes area; streamed instances do not apply cost blockers. `tickCrowd` copies crowd poses into the snapshot, parents before children so each child is placed against its parent's new pose, and re-stamps moving dynamic cost volumes from their world pose. Agents face their velocity while moving (3D about +Y with +Z forward; 2D about +Z with +X forward, as Rotate To Face) and keep their facing when idle; Rotate To Face on an idle agent applies on the next tick. Replacing the navmesh stops the velocity it was steering.

Bake modal phases:

1. Non-dismissable modal on a painted frame before collect starts.
2. Names the phase (collect → generate in bake worker → write chunk).
3. Cancel is enabled only while the worker is generating; it ends the bake at once and terminates the worker. A bake worker that fails to load, crashes or sends an unreadable reply fails the bake with that error instead of leaving the modal waiting.

## Bytes on the Scene asset

| Field | Value |
| --- | --- |
| Parent | Scene `.scene.babasset` (not a creatable NavMesh asset type) |
| Chunk `id` / `kind` | `navmesh` |
| Bytes | Solo: `exportNavMesh()`. Tile cache: `BSNT` + `exportTileCache()` |
| Save | `extraChunksWithNavmesh` / `extraChunksFromDecoded` |

## Scripting and BT MoveTo

Play's navigation state (Scene navmesh selection, crowd agents, obstacles, cost volumes, the MoveTo task host and `debugNavigation`) lives in `RuntimeNavigation` (`packages/runtime/src/runtime-navigation.ts`). The driver forwards its public nav methods to it and releases it on Stop; departing Scene agents clear when the main Scene is replaced.

Compiled graphs call `ctx.findPathTo` / `ctx.moveTo` / `ctx.stopMovement` / `ctx.isPathValid` / `ctx.getClosestNavigablePoint` / `ctx.getRandomPointInRadius` / `ctx.addObstacle` / `ctx.removeObstacle`. `scripting-nodes` must not import `@babylonslate/navigation`. Find Path To returns an empty array when the goal cannot be reached, so Is Path Valid is true for any non-empty path (a single point when the goal is the start). Add Obstacle's Kind is a Nav Obstacle Kind enum (`box`, the default, or `cylinder`), its pose is the volume center and its size the full extent (cylinder diameter); it returns an empty id when nothing was carved. Get Closest Navigable Point and Get Random Point In Radius have a **Found** output: on a miss (the host returns null) Found is false and the point is the zero vector.

**Move To Blackboard Key** uses the same navigation path as Move To, resolving a Vector or spatial Object/Actor Reference from the linked Blackboard. It follows changes to that value and stops when the target becomes invalid or the task is aborted.

Both crowd-update passes resolve agents through the tick's shared GUID-to-actor map, so actor lookup costs O(agents) instead of O(agents × actors). The map answers each guid with its one live actor, matching `World.findActor` and physics (live actors never share a guid, see [object-model.md](object-model.md#unique-actor-guids)). It is built with a plain loop before behavior-tree updates, only when a navmesh is loaded or behaviour trees are registered; an actor realized during that phase enters it once its spawn commits, and the map is cleared afterward. Destroyed actors and removed NavAgent components still trigger the existing cleanup; navigation simulation and component checks are unchanged.

The crowd composes world poses only for NavAgent actors and their ancestors, resolving parents through the same map instead of composing the whole world. NavAgent actors and moving cost blockers are found through the shared component owner index ([object-model.md](object-model.md)), not by walking every actor. An indexed actor destroyed after the map was built resolves against the live World. Crowd agents are keyed by guid and leave with their actor (driver removal or the publish that releases a destroyed actor's slot), so an actor that later reuses the guid, such as a reloaded Scene or Save Game actor, registers a fresh agent. Agent writes still precede the published frame, so children of crowd-moved actors follow in the same snapshot.

### Dynamic rigid bodies

In 3D worlds, a dynamic RigidBody in the main physics world remains responsible for the actor's position (a Scene Layer actor's body lives in its layer's world, so its agent follows the crowd pose like a kinematic one). NavAgent supplies XZ steering, preserves vertical velocity, and synchronizes the crowd with the physics result instead of overwriting the actor with the navmesh height. Idle agents still fall, collider offsets remain intact, and stopping navigation does not cancel a fall. An airborne movement request is retained while the actor reaches the navmesh; arrival is checked against the actual actor position, horizontally and in height. Existing static/kinematic motion settings, `gravityScale`, and 2D crowd navigation remain unchanged.

`BTTask_MoveTo` without a task host still succeeds (package stub). The runtime host requests `setNavAgentTarget` and returns `running` until the agent is inside `acceptRadius` (new Move To and Move To Blackboard Key nodes stamp 0.5; the runtime reads 0.75 only when the property is missing or non-finite). Aborting a running MoveTo calls `stopNavAgent` so the crowd does not keep the aborted target.

## Play console inspection

Play and Preview Build console commands `shownav` / `shownavdebug` toggle the baked navmesh overlay; `showpathfinding on/off` shows active crowd corridor corners and destinations. `shownavagent on/off` adds agent bounds, velocity, names and current movement state, including each agent's active path. Both default to `on` when omitted. The runtime emits `debugNavigation` at up to 5 Hz while requested, with immediate updates for commands and removals; disabling both or stopping clears the overlay. Positions, targets, velocities and path corners are remapped into 2D scene XY when applicable.

`NavigationBackend.agentDebugState(id)` returns detached live crowd position, velocity, radius, height, target, corridor path and request state, or `null` for a missing agent. Paths come from Recast's active crowd corners, so debug drawing does not issue a second path query. Stop Movement clears the path; an arrived agent has no active path. These debug commands are stripped from exports without a bundled debugger.

The baked-mesh debug importer accepts both solo navmeshes and `BSNT` tile-cache chunks used by dynamic obstacles. Each overlay extraction releases its temporary navmesh, tile cache, allocator, compressor and mesh-process handles.

## Honest residuals

- Auto-bake-on-save default **off**. Closing the Scene tab unregisters the bake collector (no painted meshes until a Scene remounts). Closing the Viewport panel on a mounted scene also unregisters collect.
- Geometry collect runs on the painted modal frame and retries a few extra frames if the first collect is empty (Viewport meshes can lag the Save click). It is not chunked across frames; the blocking modal still covers that stall.
- Cost volumes mark overlapping Recast polygons (`queryPolygons` AABB → `setPolyArea`). Large simplified polys can extend the expensive region past the authored box. Unwalkable obstacles still carve; cost does not call `addObstacle`.
- §18 editor e2e does not Play-patrol in the viewport; 2D/3D patrol and obstacle close are the headless harness. Auto Bake On Save is unit-tested in `apps/editor/src/lib/nav-bake-save.test.ts`.

See [behaviour-tree.md](behaviour-tree.md). Spec: [engineplan.md](../engineplan.md) §14.2.
