# Navigation (P11)

Shared surface for navmesh bake and worker queries (engineplan §14.2). Implementation: `@babylonslate/navigation`. Recast wasm is allowed; no React, no Babylon, no `@recast-navigation/babylon`.

Tile-cache obstacles, 2D bake input, scripting nodes, and crowd `MoveTo` are in (`p11-nav-blockers-2d`). **P19** (`p19-nav-leftovers`) wires Auto Bake On Save, bake-bounds collect, and cost volumes (Detour poly area + query-filter costs). Unwalkable tile-cache carve is unchanged. §18: `packages/runtime/src/p11-acceptance.test.ts` (including a dynamic box that **closes** an open route after MoveTo is running) plus `e2e/p11-ai.spec.ts` (including Auto Bake On Save).

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

- `generateNavMesh({ positions, indices, settings? })` → bytes. `settings.supportDynamicObstacles` selects Recast **tile cache** (`generateTileCache` + `exportTileCache`) wrapped with magic `BSNT`; otherwise solo `exportNavMesh()`. Call `initNavigation()` / generate before import. Play **never** generates.
- `createNavigationBackend()`: `importNavMesh` (detects `BSNT` vs solo), `findPath`, `closestPoint`, `randomPointInRadius`, `addObstacle` / `removeObstacle` (tile-cache **unwalkable** carve; solo stays an id-map), `applyCostVolume` (Detour `setPolyArea` to cost area `1` + `QueryFilter` / crowd `setAreaCost`; does **not** `addObstacle`), `addAgent` / `updateAgent` / `removeAgent` / `stopAgent` / `agentPosition` / `agentVelocity` / `setAgentTarget`, `stepCrowd` (moves added agents and flushes tile-cache updates). Graph **Set** of Nav Agent Radius / Height / Max Speed / Max Acceleration calls `updateAgent` on the live Recast crowd (`CrowdAgent.updateParameters`).
- Crowd steps with a fixed dt and the same navmesh bytes are identical across two backends in unit tests; if that ever fails, record agent pose into the P8 trace instead of recomputing.
- `worldToRecast` / `recastToWorld`: 2D world `(x, y, _)` ↔ Recast `(x, 0, y)`. Property-tested. No other code touches Recast axes. Runtime remaps queries and crowd pose when `physicsWorld` is `2d`.
- `facingYawFromVelocity`: Recast XZ yaw (`atan2(x, z)`), keep previous yaw below a min-length guard.
- `solidBlockerMesh` / `recastWalkableQuadFromXy` / `recastWallsFromXyChains`: bake solids. Walls are thick boxes so Recast can voxelise them.
- `navmeshChunk` / `navmeshBytesFromChunks` / `extraChunksWithNavmesh` / `NAVMESH_CHUNK_ID = "navmesh"`. Pass the chunk as `extraChunks` on Scene save; `extraChunksFromDecoded` already preserves it. Not a Content Browser type.

Recast settings (`NavMeshSettings`) are data: cell size/height, walkable slope/height/climb/radius, edge length, simplification error, region areas, verts per poly, detail sampling.

## Editor host

- Place Actors **NavMesh** spawns an Actor with `NavMeshComponent` (Recast numbers, solo/tiled enum, support-dynamic-obstacles, **Auto Bake On Save** default off, **Bake Bounds** plus min/max). Not an Add Component row. Details no longer has a **Debug Overlay** checkbox — Viewport Settings **Show Navmesh** (`scene.settings.showNavmesh`, default off) owns the overlay. A leftover `debugOverlay === true` on old documents still turns the overlay on until the scene is saved with an explicit `showNavmesh` key.
- Place Actors **NavMesh Blocker** spawns an Actor with `NavMeshBlockerComponent` (`dynamic` default false, `kind` box/cylinder, `area` unwalkable/cost, **Cost** number when Area is Cost, default 10, min > 1). Scale is the blocker size. Editor draws an amber dotted volume plus `default.png` at the center. Not Add Component / Search.
- Details **Bake NavMesh** opens a non-dismissable modal on a painted frame, collects geometry, runs `generateNavMesh` in a dedicated bake worker (tile cache when Support Dynamic Obstacles is on), writes the Scene `navmesh` chunk. A failed bake keeps the modal open with the Recast error and a Close control (Save still continues).
- Save with Auto Bake On Save awaits `flushNavBakeForSave()` (same `startBake` / `NavBakeDialog` as Bake). Export does **not** auto-bake. Open Scene workspaces stay mounted and keep a collector; closing the Scene tab unregisters collect until a Scene remounts.
- 3D collect: `MeshComponent` world meshes — origin-root / glTF **visual children**, triangle winding reversed for Recast +Y; skip editor pick proxies — plus static unwalkable blockers (**rotated by the actor quaternion**; dynamic Recast `addObstacle` still uses the world AABB of the rotated box). Dynamic / cost blockers are skipped at bake. When Bake Bounds is on, meshes, tilemap chains, and static blockers whose AABB misses the box are dropped.
- 2D collect: Recast XZ walkable quad from actor XY bounds (or the bounds box XY when enabled), `ColliderComponent` 2D shapes whose actor XY is inside the box, tilemap collision chains (`tilemapCollisionChains` / `navBakeTilemapChains`) that intersect the box XY, remapped static blockers in-box. MeshComponent XY verts are not fed to Recast.
- Debug overlay: Recast tris lifted ~0.04 on +Y, translucent green fill, darker green edge outlines, unpickable. Viewport **Show Navmesh** (and leftover `debugOverlay`) drive the editor overlay; when on, NavMesh Blocker volumes also draw. Play console `shownav` reuses the same overlay (blockers included; Blocking Volumes are not nav input and stay off this overlay).
- Play reads the Scene chunk (`readPlayNavmeshBytes`) and posts `loadNavMesh` **before** `realizePlayWorld`. `NavAgentComponent` registers `addAgent`; dynamic **unwalkable** blockers register `addObstacle`; **cost** blockers (static and dynamic) call `applyCostVolume`; `tickCrowd` copies pose + `facingYawFromVelocity` into the snapshot and re-stamps moving dynamic cost volumes.

Bake modal phases:

1. Non-dismissable modal on a painted frame before collect starts.
2. Names the phase (collect → generate in bake worker → write chunk).
3. Cancel is enabled only while the worker is generating.

## Bytes on the Scene asset

| Field | Value |
| --- | --- |
| Parent | Scene `.scene.babasset` (not a creatable NavMesh asset type) |
| Chunk `id` / `kind` | `navmesh` |
| Bytes | Solo: `exportNavMesh()`. Tile cache: `BSNT` + `exportTileCache()` |
| Save | `extraChunksWithNavmesh` / `extraChunksFromDecoded` |

## Scripting and BT MoveTo

Compiled graphs call `ctx.findPathTo` / `ctx.moveTo` / `ctx.stopMovement` / `ctx.isPathValid` / `ctx.getClosestNavigablePoint` / `ctx.getRandomPointInRadius` / `ctx.addObstacle` / `ctx.removeObstacle`. `scripting-nodes` must not import `@babylonslate/navigation`.

`BTTask_MoveTo` without a task host still succeeds (package stub). The runtime host requests `setNavAgentTarget` and returns `running` until the agent is inside `acceptRadius` (default 0.75). Aborting a running MoveTo calls `stopNavAgent` so the crowd does not keep the aborted target.

## Honest residuals

- Auto-bake-on-save default **off**. Closing the Scene tab unregisters the bake collector (no painted meshes until a Scene remounts). Closing the Viewport panel on a mounted scene also unregisters collect.
- Geometry collect runs on the painted modal frame and retries a few extra frames if the first collect is empty (Viewport meshes can lag the Save click). It is not chunked across frames; the blocking modal still covers that stall.
- Cost volumes mark overlapping Recast polygons (`queryPolygons` AABB → `setPolyArea`). Large simplified polys can extend the expensive region past the authored box. Unwalkable obstacles still carve; cost does not call `addObstacle`.
- Tiled generate without `supportDynamicObstacles` still uses solo unless the dynamic-obstacles toggle is on.
- §18 editor e2e does not Play-patrol in the viewport; 2D/3D patrol and obstacle close are the headless harness. Auto Bake On Save is covered in `e2e/p11-ai.spec.ts`.

See [behaviour-tree.md](behaviour-tree.md). Spec: [engineplan.md](../engineplan.md) §14.2.
