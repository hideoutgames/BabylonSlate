# Navigation (P11)

Shared surface for navmesh bake and worker queries (engineplan §14.2). Implementation: `@babylonslate/navigation`. Recast wasm is allowed; no React, no Babylon, no `@recast-navigation/babylon`.

The package crowd API (`addAgent` / `stepCrowd`) and the editor host (`p11-nav-editor-host`) are in. `NavAgentComponent` is addable. Tile-cache obstacles, 2D bake input, scripting nodes, and a real BT MoveTo stay `p11-nav-blockers-2d`.

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `navigation` | Recast generate / `exportNavMesh` / `importNavMesh` round-trip, `NavigationBackend`, 2D XY↔XZ remap, facing-from-velocity, Scene `navmesh` chunk helpers, Recast `DebugDrawerUtils` primitives | React, Babylon, Capacitor, `@recast-navigation/babylon` |
| `apps/editor` | Mesh geometry collect, bake worker host, blocking bake modal, NavMesh Place Actor + Recast settings Details, Play `loadNavMesh` of the Scene chunk | Capacitor |
| `render` | Main-thread mesh collect for bake; editor debug overlay mesh from Recast primitives | React, Capacitor |
| `runtime` | Import scene `navmesh` chunk; `NavAgentComponent` → `addAgent`; `stepCrowd` into the snapshot | Babylon, DOM |

Do **not** use Babylon `RecastJSPlugin`. `@recast-navigation/core` + `generators` own the byte format. `@recast-navigation/babylon` is not a published npm package; editor debug draw uses Recast `DebugDrawerUtils` in `navigation` plus a Babylon wireframe mesh in `render`.

## Package API (`p11-navigation`)

- `generateNavMesh({ positions, indices, settings? })` → `exportNavMesh()` bytes (solo mesh). Call `initNavigation()` / generate before import.
- `createNavigationBackend()`: `importNavMesh`, `findPath`, `closestPoint`, `randomPointInRadius`, `addObstacle` / `removeObstacle` (ids only; **tile-cache carving is `p11-nav-blockers-2d`**), `addAgent` / `removeAgent` / `agentPosition` / `agentVelocity` / `setAgentTarget`, `stepCrowd` (moves added agents).
- Crowd steps with a fixed dt and the same navmesh bytes are identical across two backends in unit tests; if that ever fails, record agent pose into the P8 trace instead of recomputing.
- `worldToRecast` / `recastToWorld`: 2D world `(x, y, _)` ↔ Recast `(x, 0, y)`. Property-tested. No other code touches Recast axes.
- `facingYawFromVelocity`: Recast XZ yaw (`atan2(x, z)`), keep previous yaw below a min-length guard.
- `navmeshChunk` / `navmeshBytesFromChunks` / `extraChunksWithNavmesh` / `NAVMESH_CHUNK_ID = "navmesh"`. Pass the chunk as `extraChunks` on Scene save; `extraChunksFromDecoded` already preserves it. Not a Content Browser type.

Recast settings (`NavMeshSettings`) are data: cell size/height, walkable slope/height/climb/radius, edge length, simplification error, region areas, verts per poly, detail sampling.

## Editor host (`p11-nav-editor-host`)

- Place Actors **NavMesh** spawns an Actor with `NavMeshComponent` (Recast numbers, solo/tiled enum, support-dynamic-obstacles, auto-bake-on-save default **off**, debug overlay). Not an Add Component row.
- Details **Bake NavMesh** opens a non-dismissable modal on a painted frame, collects `MeshComponent` actors on the main thread, runs `generateNavMesh` in a dedicated bake worker, writes the Scene `navmesh` chunk. Play **never** generates.
- Debug overlay: Recast primitives → Babylon wireframe when `debugOverlay` is on.
- Play reads the Scene chunk (`readPlayNavmeshBytes`) and posts `loadNavMesh` **before** `realizePlayWorld`. `NavAgentComponent` registers `addAgent`; `tickCrowd` copies pose + `facingYawFromVelocity` into the snapshot.
- 3D bake source is MeshComponent meshes. 2D tilemap chains wait for `p11-nav-blockers-2d`. Tiled generate / tile cache also wait even if the Details toggle is on.

Bake modal phases:

1. Non-dismissable modal on a painted frame before collect starts.
2. Names the phase (collect → generate in bake worker → write chunk).
3. Cancel is enabled only while the worker is generating.

## Bytes on the Scene asset

| Field | Value |
| --- | --- |
| Parent | Scene `.scene.babasset` (not a creatable NavMesh asset type) |
| Chunk `id` / `kind` | `navmesh` |
| Bytes | `exportNavMesh()` |
| Save | `extraChunksWithNavmesh` / `extraChunksFromDecoded` |

## Later slices (do not start here)

| Slice | Work |
| --- | --- |
| `p11-nav-blockers-2d` | Static vs dynamic `NavMeshBlockerActor`, area cost, tile-cache obstacles, 2D tilemap/collider bake input, scripting FindPathTo / MoveTo / …, BT MoveTo replacing the succeed stub |

`BehaviourTreeComponent` MoveTo still succeeds without a crowd until `p11-nav-blockers-2d`. Catalogs: `BehaviourTreeComponent` and `NavAgentComponent` are addable.

See [behaviour-tree.md](behaviour-tree.md). Spec: [engineplan.md](../engineplan.md) §14.2.
