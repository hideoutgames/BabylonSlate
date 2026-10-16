# Tilemaps

Tileset and Tilemap assets, chunked geometry, merged chain collision, animated tiles and the paint editor.

## Decisions

- Not Babylon `SpriteMap`: that format cannot golden-test geometry or emit collision chains.
- Geometry and collision builders in `@babylonslate/assets` are pure and Babylon-free; callers pass world tile size (`px / pixelsPerUnit`) so assets never read project settings.
- Atlas materials stay unlit, double-sided and alpha-tested (same path as sprites) in both 2D and 3D; they disable fog and image processing. Switching to blend needs an on-device fill-rate measurement.
- Autotile / terrain rules are not implemented.

## Ownership

| Area | Source |
| --- | --- |
| Tileset payload, `tilesetTileRect`, `tilesetTileUv`, `atlasCellAt` | [`packages/assets/src/tileset-payload.ts`](../../../packages/assets/src/tileset-payload.ts) |
| Tilemap payload, GID encode/decode, `reconcileTilemapTilesets`, `TilemapChunkIndex` | [`packages/assets/src/tilemap-payload.ts`](../../../packages/assets/src/tilemap-payload.ts) |
| Chunk geometry `tilemapChunkVertexData` | [`packages/assets/src/tilemap-chunk.ts`](../../../packages/assets/src/tilemap-chunk.ts) |
| Collision chains `tilemapLayerChains` / `tilemapCollisionChains` | [`packages/assets/src/tilemap-chains.ts`](../../../packages/assets/src/tilemap-chains.ts) |
| Paint ops, stroke merge key | [`packages/assets/src/tilemap-paint.ts`](../../../packages/assets/src/tilemap-paint.ts) |
| Meshes, atlas binding, parallax | [`packages/render/src/tilemap-mesh.ts`](../../../packages/render/src/tilemap-mesh.ts) |
| Physics chains (`PhysicsWorldSync`) | [`packages/runtime/src/physics-sync.ts`](../../../packages/runtime/src/physics-sync.ts) |
| Animation clock (`tilemapAnimationTime`) | [`packages/runtime/src/driver.ts`](../../../packages/runtime/src/driver.ts) |
| Editor providers | [`apps/editor/src/context/tilemap-editing-context.tsx`](../../../apps/editor/src/context/tilemap-editing-context.tsx), [`tileset-editing-context.tsx`](../../../apps/editor/src/context/tileset-editing-context.tsx), [`tilemap-tileset-payloads.ts`](../../../apps/editor/src/context/tilemap-tileset-payloads.ts) |

## Formats

- Tileset (`.tileset.babasset`, kind `tileset`): `textureGuid`, `atlasWidth/Height` (source pixels, needed before the texture loads), `tileWidth/Height`, `margin`, `spacing`, per-id `tiles` metadata (`collision` none / full / chain points, `flags`, `animation`, `animationFrameDurationMs`).
- Tile id 0 is empty; id 1 is the first atlas cell, row 0 at the image top.
- Tilemap (`.tilemap.babasset`, kind `tilemap`): Tiled-style `tilesets` `{ guid, firstGid, tileCount }`; cells store global GIDs (`firstGid + localId - 1`); `tileWidth/Height`; `width/height` in tiles (default 64×64); `chunkSize` (default 32); ordered `layers` with visibility, collision opt-in, sorting, parallax and sparse chunks.
- Chunk `{ cx, cy, tiles }`, `tiles.length === chunkSize²`, index `ly * chunkSize + lx`, (0,0) bottom-left, +Y up, XY plane. Empty cells and chunks are never allocated.
- `decodeTileGid` picks the highest `firstGid <= gid`; a map without tilesets owns no GIDs. `tileCount` never shrinks; `reconcileTilemapTilesets` relocates growing ranges and remaps cells as part of the next authored edit (so it undoes with it). Closed maps are never rewritten across documents.
- Removing a Tileset erases its painted cells without compacting other GIDs.

## Geometry and render

- One draw per chunk per atlas, tile 0 skipped; quad order BL, BR, TR, TL like sprite `CreatePlane`. Quads occupy exact grid cells; UVs inset half a texel so NEAREST never samples a neighbor.
- Albedo uses a per-sampling-key `ResourceCache` wrapper (`PIXEL_ART_TEXTURE_SAMPLING`). Extra keys use another `createObjectURL` of the same Blob — never `#nomip` / `#ninv` fragments on `blob:` URLs; use explicit loader hints.
- Play builds `actor-N` plus one child per non-empty static chunk per atlas (`:a1`, `:a2` …) and an `:anim` sibling for animated tiles. Editor children are `editorActor:<id>:<layer>:<cx>:<cy>`; picking maps back to the actor.
- Animated tiles update only their UV buffers. Play/Preview Build use the runtime `tilemapAnimationTime` (simulation time: pause holds, step advances, dilation scales); the editor uses presentation time. The binary snapshot format is unchanged.
- Parallax offset = camera × (1 − parallax), applied after camera posing and pixel snap via `updateSceneTilemapParallax`; overlay slots skip it.
- A Tilemap component is one sorting group; layers sort inside it by project sorting layer, `orderInLayer`, then list order. Depth testing stays on.
- Disposal or rebinding disposes the owned albedo material but never the shared cache texture.

## Collision

- `tilemapLayerChains` merges `full` tiles across all chunks of a layer in integer grid space before scaling: a solid rectangle is one four-point loop with no seams at chunk borders. Custom chain tiles emit open polylines.
- `PhysicsWorldSync` gives every `TilemapComponent` actor a static body and attaches chains only for layers with `collision: true`. Rapier closed loops use an indexed closing segment; repeating the first point makes raycasts miss.
- Nav bake and editor Drop use the same chains (`tilemapCollisionChains`).

## Editor rules

- Tileset and Tilemap are DockView documents with Windows enabled (Tileset: Preview + Inspector; Tilemap: Paint primary, Palette, Inspector). Default tool is Move; two-finger pinch/pan works in every tool and a second finger drops an in-progress stroke without committing.
- One document edit per stroke: the stroke previews locally and commits on release or cancel with merge key `tilemap-stroke:<id>`. Unchanged strokes commit nothing. `setTiles` copies each touched chunk once and returns the same map when nothing changed.
- Tile Width/Height use local drafts committed by **Confirm Tile Size** to avoid rebuilding the atlas per keystroke.
- Panels share one Tileset payload map from `TilemapEditingProvider`, cached per source object; painting never reads Tilesets from storage.
- The Create Project 2D card stays minimal (2D viewport and physics, no default cube, pixel-perfect on); do not turn it into a demo scene.
