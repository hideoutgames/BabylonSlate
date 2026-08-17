# Navigation (P11)

Shared surface for navmesh bake and worker queries (engineplan §14.2). Implementation: `@babylonslate/navigation`. Recast wasm is allowed; no React, no Babylon, no `@recast-navigation/babylon`.

Tile-cache obstacles, 2D bake input, scripting nodes, and crowd `MoveTo` are in (`p11-nav-blockers-2d`). Auto-bake-on-save stays **off** until **P17** (`p17-nav-leftovers`). Dynamic **cost** volumes are recorded but do not yet affect path cost (Recast tile cache obstacles are unwalkable-only; P17 picks a mechanism that can express cost). Bake bounds collect is P17. §18: `packages/runtime/src/p11-acceptance.test.ts` (including a dynamic box that **closes** an open route after MoveTo is running) plus `e2e/p11-ai.spec.ts`.

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `navigation` | Recast generate / `exportNavMesh` / `importNavMesh` / tile-cache `exportTileCache` round-trip, `NavigationBackend`, 2D XY↔XZ remap, facing-from-velocity, Scene `navmesh` chunk helpers, Recast `DebugDrawerUtils` primitives, static blocker meshes | React, Babylon, Capacitor, `@recast-navigation/babylon` |
| `apps/editor` | Mesh / blocker / 2D collect, bake worker host, blocking bake modal, NavMesh + NavMesh Blocker Place Actors, Recast settings Details | Capacitor |
| `render` | Main-thread collect for bake; editor debug overlay mesh from Recast primitives | React, Capacitor |
| `runtime` | Import scene `navmesh` chunk; `NavAgentComponent` → `addAgent`; dynamic `NavMeshBlockerComponent` → `addObstacle`; `stepCrowd` into the snapshot; BT `MoveTo` | Babylon, DOM |
| `scripting-nodes` | FindPathTo / MoveTo / StopMovement / IsPathValid / GetClosestNavigablePoint / GetRandomPointInRadius / obstacle add/remove (`ctx.*`, no Recast import) | React, Babylon, Capacitor, `@babylonslate/navigation` |

Do **not** use Babylon `RecastJSPlugin`. `@recast-navigation/core` + `generators` own the byte format. `@recast-navigation/babylon` is not a published npm package; editor debug draw uses Recast `DebugDrawerUtils` in `navigation` plus a Babylon wireframe mesh in `render`.

## Package API (`p11-navigation` + `p11-nav-blockers-2d`)

- `generateNavMesh({ positions, indices, settings? })` → bytes. `settings.supportDynamicObstacles` selects Recast **tile cache** (`generateTileCache` + `exportTileCache`) wrapped with magic `BSNT`; otherwise solo `exportNavMesh()`. Call `initNavigation()` / generate before import. Play **never** generates.
- `createNavigationBackend()`: `importNavMesh` (detects `BSNT` vs solo), `findPath`, `closestPoint`, `randomPointInRadius`, `addObstacle` / `removeObstacle` (tile-cache **unwalkable** carve; solo stays an id-map), `addAgent` / `removeAgent` / `stopAgent` / `agentPosition` / `agentVelocity` / `setAgentTarget`, `stepCrowd` (moves added agents and flushes tile-cache updates).
- Crowd steps with a fixed dt and the same navmesh bytes are identical across two backends in unit tests; if that ever fails, record agent pose into the P8 trace instead of recomputing.
- `worldToRecast` / `recastToWorld`: 2D world `(x, y, _)` ↔ Recast `(x, 0, y)`. Property-tested. No other code touches Recast axes. Runtime remaps queries and crowd pose when `physicsWorld` is `2d`.
- `facingYawFromVelocity`: Recast XZ yaw (`atan2(x, z)`), keep previous yaw below a min-length guard.
- `solidBlockerMesh` / `recastWalkableQuadFromXy` / `recastWallsFromXyChains`: bake solids. Walls are thick boxes so Recast can voxelise them.
- `navmeshChunk` / `navmeshBytesFromChunks` / `extraChunksWithNavmesh` / `NAVMESH_CHUNK_ID = "navmesh"`. Pass the chunk as `extraChunks` on Scene save; `extraChunksFromDecoded` already preserves it. Not a Content Browser type.

Recast settings (`NavMeshSettings`) are data: cell size/height, walkable slope/height/climb/radius, edge length, simplification error, region areas, verts per poly, detail sampling.

## Editor host

- Place Actors **NavMesh** spawns an Actor with `NavMeshComponent` (Recast numbers, solo/tiled enum, support-dynamic-obstacles, debug overlay). Auto-bake-on-save stays **off** and is not shown in Details until **P17** wires it. Not an Add Component row.
- Place Actors **NavMesh Blocker** spawns an Actor with `NavMeshBlockerComponent` (`dynamic` default false, `kind` box/cylinder, `area` unwalkable/cost). Scale is the blocker size. Not Add Component / Search.
- Details **Bake NavMesh** opens a non-dismissable modal on a painted frame, collects geometry, runs `generateNavMesh` in a dedicated bake worker (tile cache when Support Dynamic Obstacles is on), writes the Scene `navmesh` chunk.
- 3D collect: `MeshComponent` world meshes + static unwalkable blockers. Dynamic / cost blockers are skipped at bake.
- 2D collect: Recast XZ walkable quad from actor XY bounds, `ColliderComponent` 2D shapes, tilemap collision chains (`tilemapCollisionChains` / `navBakeTilemapChains`), remapped static blockers. MeshComponent XY verts are not fed to Recast.
- Debug overlay: Recast primitives → Babylon wireframe when `debugOverlay` is on.
- Play reads the Scene chunk (`readPlayNavmeshBytes`) and posts `loadNavMesh` **before** `realizePlayWorld`. `NavAgentComponent` registers `addAgent`; dynamic blockers register `addObstacle`; `tickCrowd` copies pose + `facingYawFromVelocity` into the snapshot.

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

- Auto-bake-on-save default off. The data field still defaults to `false`; Details does not show a toggle because enabling it does not bake.
- Bake bounds are not a NavMesh setting; collect uses the scene's meshes or 2D XY actor bounds.
- Geometry collect is one-shot on the painted modal frame, not chunked across frames. The blocking modal still covers that stall.
- Dynamic **cost** area does not carve (no Recast tile-cache cost volume).
- Tiled generate without `supportDynamicObstacles` still uses solo unless the dynamic-obstacles toggle is on.
- §18 editor e2e does not Play-patrol in the viewport; 2D/3D patrol and obstacle close are the headless harness.

See [behaviour-tree.md](behaviour-tree.md). Spec: [engineplan.md](../engineplan.md) §14.2.
