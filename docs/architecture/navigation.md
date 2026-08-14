# Navigation (P11)

Shared surface for navmesh bake and worker queries (engineplan §14.2, checklist `p11-navigation` / `p11-nav-blockers-2d`). Planned package: `@babylonslate/navigation`. **Not implemented in `p11-behaviour-tree`.** This note locks the port so bake and query can land without a second format.

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `navigation` | Recast bake/query port, `exportNavMesh` / `importNavMesh` round-trip, crowd step, 2D XY↔XZ remap | React, Babylon (recast wasm is allowed) |
| `apps/editor` | Geometry collect (main thread), bake worker, blocking bake modal, NavMesh actor Details | Capacitor |
| `render` | Editor debug draw via `@recast-navigation/babylon` only | React, Capacitor |
| `runtime` | Load scene `navmesh` chunk; tick crowd; no Babylon | Babylon, DOM |

Do **not** use Babylon `RecastJSPlugin` — it is Scene-coupled and main-thread-only. One library (`@recast-navigation/core` + `generators`) owns the byte format.

## Bytes on the Scene asset

Bake in the editor; **never** generate at Play start.

| Field | Value |
| --- | --- |
| Parent | Scene `.scene.babasset` (not a creatable NavMesh asset type) |
| Chunk `id` / `kind` | `navmesh` |
| Bytes | `exportNavMesh()` |
| Save | `extraChunksFromDecoded` already preserves non-document chunks |

A NavMesh **actor** in the scene owns Recast settings, bake bounds, solo vs tiled, dynamic-obstacle tile cache toggle, Bake, optional auto-bake-on-save (off by default).

## Port (API to land with `p11-navigation`)

```ts
type NavPoint = { x: number; y: number; z: number };

type NavigationBackend = {
  importNavMesh(bytes: Uint8Array): void;
  findPath(from: NavPoint, to: NavPoint): NavPoint[];
  closestPoint(point: NavPoint): NavPoint | null;
  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null;
  addObstacle(kind: "box" | "cylinder", pose: NavPoint, size: NavPoint): string;
  removeObstacle(id: string): void;
  stepCrowd(dtSeconds: number): void;
};
```

Agent facing is derived from velocity with a minimum-length guard (Recast crowd has no orientation).

## 2D remap

Single pure pair with round-trip property tests. No other code touches Recast coordinates.

- 2D world `(x, y, _)` → Recast `(x, 0, y)` (XZ plane, Y up in Recast).
- Paths and crowd positions map back to XY.
- 2D bake input is tilemap collision chains and 2D colliders, extruded as prisms on Recast Y.

## Bake modal

Main-thread merge cannot run in a worker (Babylon/Recast geometry collect). Pressing Bake:

1. Shows a non-dismissable modal on a painted frame before collect starts.
2. Names the phase (collect → generate in bake worker → write chunk).
3. Releases the editor once the worker has the positions/indices (cancellable progress).

## Later slices

| Slice | Work |
| --- | --- |
| `p11-navigation` | Package + bake worker + chunk read/write + NavMesh actor UI |
| `p11-nav-blockers-2d` | Static vs dynamic `NavMeshBlockerActor`, area cost, scripting FindPathTo / MoveTo / …, BT MoveTo |

`BehaviourTreeComponent` MoveTo waits on this port. Catalogs stay gated until authoring lands.

See [behaviour-tree.md](behaviour-tree.md). Spec: [engineplan.md](../engineplan.md) §14.2.
