# Tilemaps

Tileset and Tilemap assets, chunked geometry, merged chain collision, animated tiles, autotile terrains and the paint editor.

## Decisions

- Not Babylon `SpriteMap`: that format cannot golden-test geometry or emit collision chains.
- Geometry and collision builders in `@babylonslate/assets` are pure and Babylon-free; callers pass world tile size (`px / pixelsPerUnit`) so assets never read project settings.
- Atlas materials stay unlit, double-sided and alpha-tested (same path as sprites) in both 2D and 3D; they disable fog and image processing. Switching to blend needs an on-device fill-rate measurement.
- Autotile terrains resolve at paint time into ordinary GIDs: render, physics, nav bake and the runtime never see terrain data, and a painted map stays valid if its terrains change.
- The author picks the autotile style per terrain (`sides` or `blob`) rather than per Tileset, so one sheet can mix a 4-side strip set and a blob ground set.
- One terrain per tile: a neighbour's terrain is unambiguous, so re-resolving never has to guess.

## Ownership

| Area | Source |
| --- | --- |
| Tileset payload, `tilesetTileRect`, `tilesetTileUv`, `atlasCellAt` | [`packages/assets/src/tileset-payload.ts`](../../../packages/assets/src/tileset-payload.ts) |
| Tilemap payload, GID encode/decode, `reconcileTilemapTilesets`, `TilemapChunkIndex` | [`packages/assets/src/tilemap-payload.ts`](../../../packages/assets/src/tilemap-payload.ts) |
| Chunk geometry `tilemapChunkVertexData` | [`packages/assets/src/tilemap-chunk.ts`](../../../packages/assets/src/tilemap-chunk.ts) |
| Collision chains `tilemapLayerChains` / `tilemapCollisionChains` | [`packages/assets/src/tilemap-chains.ts`](../../../packages/assets/src/tilemap-chains.ts) |
| Paint ops, stroke merge key | [`packages/assets/src/tilemap-paint.ts`](../../../packages/assets/src/tilemap-paint.ts) |
| Terrain masks, `canonicalTerrainMask`, `terrainMatchScore`, `createTerrainResolver` | [`packages/assets/src/tileset-terrain.ts`](../../../packages/assets/src/tileset-terrain.ts) |
| Terrain painting `paintTilemapTerrain`, `tilemapTerrainKeyOf` | [`packages/assets/src/tilemap-terrain.ts`](../../../packages/assets/src/tilemap-terrain.ts) |
| Meshes, atlas binding, parallax | [`packages/render/src/tilemap-mesh.ts`](../../../packages/render/src/tilemap-mesh.ts) |
| Physics chains (`PhysicsWorldSync`) | [`packages/runtime/src/physics-sync.ts`](../../../packages/runtime/src/physics-sync.ts) |
| Animation clock (`tilemapAnimationTime`) | [`packages/runtime/src/driver.ts`](../../../packages/runtime/src/driver.ts) |
| Editor providers | [`apps/editor/src/context/tilemap-editing-context.tsx`](../../../apps/editor/src/context/tilemap-editing-context.tsx), [`tileset-editing-context.tsx`](../../../apps/editor/src/context/tileset-editing-context.tsx), [`tilemap-tileset-payloads.ts`](../../../apps/editor/src/context/tilemap-tileset-payloads.ts) |

## Formats

- Tileset (`.tileset.babasset`, kind `tileset`): `textureGuid`, `atlasWidth/Height` (source pixels, needed before the texture loads), `tileWidth/Height`, `margin`, `spacing`, per-id `tiles` metadata (`collision` none / full / chain points, `flags`, `animation`, `animationFrameDurationMs`, optional `terrain`), optional `terrains`.
- Terrains: `terrains: [{ id, name, style: "sides" | "blob" }]` (unknown style → `sides`); a member tile has `terrain: { id, mask }`. Both keys are optional and omitted when empty, so older Tilesets decode unchanged (additive, no header version bump); normalize drops a membership whose terrain the Tileset does not define and clamps `mask` to 8 bits. `mask` stores raw bits so switching style keeps corner bits; the style's canonical form is applied when resolving.
- Mask bits, clockwise from north in +Y-up tile space: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128 (`TERRAIN_*`). Canonical `sides` keeps N/E/S/W (16 variants); canonical `blob` keeps a corner only when both adjacent sides are set (47 variants).
- Tile id 0 is empty; id 1 is the first atlas cell, row 0 at the image top.
- Tilemap (`.tilemap.babasset`, kind `tilemap`): Tiled-style `tilesets` `{ guid, firstGid, tileCount }`; cells store global GIDs (`firstGid + localId - 1`); `tileWidth/Height`; `width/height` in tiles (default 64×64); `chunkSize` (default 32); ordered `layers` with visibility, collision opt-in, sorting, parallax and sparse chunks.
- Chunk `{ cx, cy, tiles }`, `tiles.length === chunkSize²`, index `ly * chunkSize + lx`, (0,0) bottom-left, +Y up, XY plane. Empty cells and chunks are never allocated.
- `decodeTileGid` picks the highest `firstGid <= gid`; a map without tilesets owns no GIDs. `tileCount` never shrinks; `reconcileTilemapTilesets` relocates growing ranges and remaps cells as part of the next authored edit (so it undoes with it). Closed maps are never rewritten across documents.
- Removing a Tileset erases its painted cells without compacting other GIDs.

## Geometry and render

- One draw per chunk per atlas, tile 0 skipped; quad order BL, BR, TR, TL like sprite `CreatePlane`. Quads occupy exact grid cells; UVs inset half a texel so NEAREST never samples a neighbor.
- An atlas without a texture draws per-tile vertex colours (`tilePlaceholderHsl(gid)`, the same hue as the paint canvas) on one shared unlit, double-sided, fog-free Standard material per Scene (`applyTilemapAlbedoTextures`); chunks never keep Babylon's lit default material.
- Albedo uses a per-sampling-key `ResourceCache` wrapper (`PIXEL_ART_TEXTURE_SAMPLING`). Extra keys use another `createObjectURL` of the same Blob — never `#nomip` / `#ninv` fragments on `blob:` URLs; use explicit loader hints.
- Play builds `actor-N` plus one child per non-empty static chunk per atlas (`:a1`, `:a2` …) and an `:anim` sibling for animated tiles. Editor children are `editorActor:<id>:<layer>:<cx>:<cy>`; picking maps back to the actor.
- Animated tiles update only their UV buffers. Play/Preview Build use the runtime `tilemapAnimationTime` (simulation time: pause holds, step advances, dilation scales); the editor uses presentation time. The binary snapshot format is unchanged.
- Parallax offset = camera × (1 − parallax), applied after camera posing and pixel snap via `updateSceneTilemapParallax`; overlay slots skip it.
- A Tilemap component is one sorting group; layers sort inside it by project sorting layer, `orderInLayer`, then list order. Depth testing stays on.
- Disposal or rebinding disposes the owned albedo material but never the shared cache texture.

## Terrains (autotile)

- A neighbour joins a cell when it holds a tile of the same terrain of the same Tileset (`tilemapTerrainKey`: guid + terrain id). Plain tiles and other terrains never join. Cells outside the map always join, so ground drawn to the map edge runs on past it instead of capping there.
- Resolution (`createTerrainResolver`): the member tile whose canonical mask equals the wanted canonical mask; otherwise the closest by `terrainMatchScore`, compared in order: (1) fewest wanted sides the tile draws open, (2) fewest open sides the tile draws joined, (3) fewest inner-corner notches the tile draws that the cell does not want, (4) fewest wanted notches the tile fills, (5) lowest tile id. Corner terms count only where the tile joins both adjacent sides. Order reason: an edge drawn inside the terrain is the most visible error, a cut-off edge less so, a notch least. Incomplete sheets therefore paint: missing bottom/side edges fall back to fill, a one-high strip keeps its top tiles. `maxTileId` limits members to the map's Tileset range.
- `paintTilemapTerrain` writes the brush terrain into the target cells (or 0 when erasing), then re-resolves every target and every terrain tile in their 8-neighbourhood against the new membership. Membership never changes for neighbours, so one pass is exact; incremental brush moves equal one batch write. Reads go through `TilemapChunkIndex` positions (or a per-call chunk map), across chunk borders and missing chunks; writes go through `setTiles`, so unchanged cells keep the same map object and out-of-bounds cells are never written.
- A stroke with `terrain` set routes every tool through it: Brush/Rect/Stamp paint terrain cells, the Eraser erases and re-resolves, Bucket fills the connected cells of the start cell's terrain (whatever their variants), or of its exact GID outside a terrain, and is a no-op on the brush's own terrain. Single-tile strokes never re-resolve neighbours, so hand-placed variants stay.

## Collision

- `tilemapLayerChains` merges `full` tiles across all chunks of a layer in integer grid space before scaling: a solid rectangle is one four-point loop with no seams at chunk borders. Custom chain tiles emit open polylines.
- `PhysicsWorldSync` gives every `TilemapComponent` actor a static body and attaches chains only for layers with `collision: true`. Rapier closed loops use an indexed closing segment; repeating the first point makes raycasts miss.
- Nav bake and editor Drop use the same chains (`tilemapCollisionChains`).

## Editor rules

- Tileset and Tilemap are DockView documents with Windows enabled (Tileset: Preview + Inspector; Tilemap: Paint primary, Palette, Inspector). Default tool is Move; two-finger pinch/pan works in every tool and a second finger drops an in-progress stroke without committing.
- One document edit per stroke: the stroke previews locally and commits on release or cancel with merge key `tilemap-stroke:<id>`. Unchanged strokes commit nothing. `setTiles` copies each touched chunk once and returns the same map when nothing changed.
- Tile Width/Height use local drafts committed by **Confirm Tile Size** to avoid rebuilding the atlas per keystroke.
- Terrains are authored in the Tileset Inspector (**Terrains** list, **Selected Terrain** name and **Style**, per-tile **Terrain** and the 3 × 3 **Terrain Neighbours** toggles, which edit every selected tile of that terrain; closing a side clears its corners). Removing a terrain clears its tiles' membership in the same edit.
- The Palette lists each Tileset's terrains above its tiles; `TilemapEditingProvider.selectedTerrain` is the terrain brush and selecting a tile clears it. Strokes capture the brush and the loaded Tileset payloads at pointer-down and keep the one-edit-per-stroke commit.
- Panels share one Tileset payload map from `TilemapEditingProvider`, cached per source object; painting never reads Tilesets from storage.
- The Create Project 2D card stays minimal (2D viewport and physics, no default cube, pixel-perfect on); do not turn it into a demo scene.
