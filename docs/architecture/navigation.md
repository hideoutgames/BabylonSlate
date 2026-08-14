# Navigation (P11)

Shared surface for navmesh bake and worker queries (engineplan §14.2). Implementation: `@babylonslate/navigation`. Recast wasm is allowed; no React, no Babylon, no `@recast-navigation/babylon`.

Bake UI, Place Actors, debug draw, and runtime crowd **load** stay later slices. The package crowd API (`addAgent` / `stepCrowd`) is in this package. `NavAgentComponent` stays catalog-gated.

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `navigation` | Recast generate / `exportNavMesh` / `importNavMesh` round-trip, `NavigationBackend`, 2D XY↔XZ remap, facing-from-velocity, Scene `navmesh` chunk helpers | React, Babylon, Capacitor, `@recast-navigation/babylon` |
| `apps/editor` | Geometry collect, bake worker host, blocking bake modal, NavMesh actor Details (later) | Capacitor |
| `render` | Editor debug draw via `@recast-navigation/babylon` only (later) | React, Capacitor |
| `runtime` | Load scene `navmesh` chunk; tick crowd (later) | Babylon, DOM |

Do **not** use Babylon `RecastJSPlugin`. `@recast-navigation/core` + `generators` own the byte format.

## This slice (`p11-navigation` package)

- `generateNavMesh({ positions, indices, settings? })` → `exportNavMesh()` bytes (solo mesh). Call `initNavigation()` / generate before import.
- `createNavigationBackend()`: `importNavMesh`, `findPath`, `closestPoint`, `randomPointInRadius`, `addObstacle` / `removeObstacle` (ids only; **tile-cache carving is `p11-nav-blockers-2d`**), `addAgent` / `removeAgent` / `agentPosition` / `setAgentTarget`, `stepCrowd` (moves added agents).
- Crowd steps with a fixed dt and the same navmesh bytes are identical across two backends in unit tests; if that ever fails, record agent pose into the P8 trace instead of recomputing.
- `worldToRecast` / `recastToWorld`: 2D world `(x, y, _)` ↔ Recast `(x, 0, y)`. Property-tested. No other code touches Recast axes.
- `facingYawFromVelocity`: Recast XZ yaw (`atan2(x, z)`), keep previous yaw below a min-length guard.
- `navmeshChunk` / `navmeshBytesFromChunks` / `NAVMESH_CHUNK_ID = "navmesh"`. Pass the chunk as `extraChunks` on Scene save; `extraChunksFromDecoded` already preserves it. Not a Content Browser type.

Recast settings (`NavMeshSettings`) are data: cell size/height, walkable slope/height/climb/radius, edge length, simplification error, region areas, verts per poly, detail sampling.

## Bytes on the Scene asset

Bake in the editor (later); **never** generate at Play start.

| Field | Value |
| --- | --- |
| Parent | Scene `.scene.babasset` (not a creatable NavMesh asset type) |
| Chunk `id` / `kind` | `navmesh` |
| Bytes | `exportNavMesh()` |
| Save | `extraChunksFromDecoded` already preserves non-document chunks |

## Later slices (do not start here)

| Slice | Work |
| --- | --- |
| Nav editor host | Main-thread geometry collect, bake worker wrapping `generateNavMesh`, blocking bake modal, NavMesh Place Actor + Recast settings Details, `@recast-navigation/babylon` debug draw, runtime `importNavMesh` + `addAgent` / `stepCrowd` |
| `p11-nav-blockers-2d` | Static vs dynamic `NavMeshBlockerActor`, area cost, tile-cache obstacles, scripting FindPathTo / MoveTo / …, BT MoveTo |

Bake modal (when the editor host lands):

1. Non-dismissable modal on a painted frame before collect starts.
2. Names the phase (collect → generate in bake worker → write chunk).
3. Releases the editor once the worker has positions/indices (cancellable progress).

`BehaviourTreeComponent` MoveTo waits on this port. Catalogs stay gated until `p11-bt-authoring`.

See [behaviour-tree.md](behaviour-tree.md). Spec: [engineplan.md](../engineplan.md) §14.2.
