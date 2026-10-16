# Navigation

Recast navmesh bake, Scene `navmesh` chunk, runtime crowd/obstacles/cost volumes, scripting hooks and debug overlays.

## Invariants

- `@babylonslate/navigation` may use Recast wasm (`@recast-navigation/core` / `generators`) but must not import React, Babylon, Capacitor or `@recast-navigation/babylon` (not a published package). Do not use Babylon `RecastJSPlugin`.
- `@babylonslate/scripting-nodes` must not import `@babylonslate/navigation`; graphs call `ctx.*` hooks.
- Play never generates a navmesh; it only imports baked bytes. Export never auto-bakes.
- `worldToRecast` / `recastToWorld` are the only 2D axis remap (world `(x, y)` ↔ Recast `(x, 0, y)`); no other code touches Recast axes.
- A navmesh is not a Content Browser asset: bytes live in the Scene's `navmesh` chunk.

## Ownership

| Area | Source |
| --- | --- |
| Generate / export / import, tile cache, backend, remap, facing, blocker solids, chunk helpers, debug primitives, bake worker | [`packages/navigation/src/`](../../../packages/navigation/src/) (`recast-backend.ts`, `geometry.ts`, `blockers.ts`, `remap.ts`, `facing.ts`, `chunk.ts`, `debug-primitives.ts`, `bake-worker.ts`) |
| Play navigation state (`RuntimeNavigation`) | [`packages/runtime/src/runtime-navigation.ts`](../../../packages/runtime/src/runtime-navigation.ts) |
| Graph nodes (`ctx.findPathTo`, `ctx.moveTo`, …) | [`packages/scripting-nodes/src/navigation.ts`](../../../packages/scripting-nodes/src/navigation.ts) |
| Bake collect, modal, Save auto-bake | [`apps/editor/src/context/nav-bake-context.tsx`](../../../apps/editor/src/context/nav-bake-context.tsx), [`apps/editor/src/lib/nav-bake-save.ts`](../../../apps/editor/src/lib/nav-bake-save.ts) |
| Chunk write (`writeSceneNavmeshChunk`) | [`apps/editor/src/services/project-service.ts`](../../../apps/editor/src/services/project-service.ts) |
| Play bytes (`readPlayNavmeshBytes`) | [`apps/editor/src/lib/play-content.ts`](../../../apps/editor/src/lib/play-content.ts) |
| Bake collect, editor and Play overlays | [`packages/render/src/`](../../../packages/render/src/) (`nav-bake-geometry.ts`, `nav-debug-overlay.ts`, `play-navigation-overlay.ts`) |

## Formats

| Field | Value |
| --- | --- |
| Parent | Scene `.scene.babasset` extra chunk |
| Chunk id | `NAVMESH_CHUNK_ID = "navmesh"` |
| Solo / tiled | `exportNavMesh()` bytes |
| Tile cache (dynamic obstacles) | magic `BSNT` + `exportTileCache()` |

- Scene Save preserves the stored chunk without reading it; `writeSceneNavmeshChunk` writes it after the other chunks. Readers load it by chunk id.
- `NavMeshSettings` stay in Recast's own units (cells, cell heights, degrees); generators apply conversions.

## Backend contracts

- `importNavMesh` decodes before releasing the live mesh, so a failed import keeps it. `findPath` returns empty when unreachable, never a partial path.
- Tile cache: 32-cell tiles, 128 obstacles; crowd: 128 agents. Full capacity returns `""` instead of throwing. Obstacle edits batch before the next query/crowd step.
- Obstacles and cost volumes take center `pose` and full `size`; cylinders use X/Z as diameters. Unwalkable obstacles carve; cost volumes set Detour poly areas and filter costs and never call `addObstacle`.
- Up to 62 distinct cost prices (area 63 is walkable); overlaps use the highest price; a 63rd distinct price throws before changing anything.
- `syncAgentPosition` projects a physics-resolved position onto the corridor without resetting the destination. `dispose()` is idempotent and the backend can import again.
- Fixed-dt crowd steps with the same bytes must be identical across backends; if that breaks, record agent pose into traces instead of recomputing.

## Editor bake

- Place Actors **NavMesh** (`NavMeshComponent`) and **NavMesh Blocker** (`NavMeshBlockerComponent`) only; neither is an Add Component row.
- Bake runs one at a time in a dedicated worker behind a non-dismissable modal on a painted frame (collect → generate → write). Cancel only during generate; worker failure fails the bake instead of hanging.
- Auto Bake On Save (default off) awaits `flushNavBakeForSave()`. Closing the Scene tab unregisters the collector.
- 3D collect: `MeshComponent` world meshes (visual children, winding reversed, pick proxies skipped) plus static unwalkable blockers. 2D collect: walkable quad around content, 2D collider shapes as walls, tilemap chains, static blockers by XY; MeshComponent XY verts are not used. Dynamic and cost blockers are skipped at bake. Bake Bounds clip inputs.
- Show Navmesh (`scene.settings.showNavmesh`, default off) owns the editor overlay; it rereads the chunk only after a registry change and redraws only when blockers, bake bytes or physics world changed (scene mesh churn re-probes shaders).

## Runtime

- Hosts pass `sceneNavmeshBytes` keyed by canonical scene guid; `loadNavMesh` imports before Play realizes. Change Scene selects the target mesh before Begin Play and clears navigation for unbaked targets. Stop disposes the session.
- `NavAgentComponent` registers agents after Begin Play, or lazily on the first Move To. Dynamic unwalkable blockers → `addObstacle`; cost blockers → `applyCostVolume` (re-stamped only when kind, cost or world pose changed). Streamed instances do not apply cost blockers.
- Crowd poses write before the published frame, parents before children. Agents face velocity while moving (3D about +Y, 2D about +Z) and keep facing when idle.
- In 3D a dynamic RigidBody owns the actor position: navigation supplies XZ steering, preserves vertical velocity and syncs the crowd to the physics result.
- Agent lookups use the tick's shared GUID-to-actor map and component owner index ([object-model.md](object-model.md)), never a per-agent world scan.
- Debug overlays (`shownav`, `showpathfinding`, `shownavagent`) read live crowd telemetry (`agentDebugState`) at up to 5 Hz; they never issue extra path queries. Blocking Volumes belong to physics, not navigation.
