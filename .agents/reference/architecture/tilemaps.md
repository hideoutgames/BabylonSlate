# Tilemaps

Tileset and Tilemap assets, chunked geometry, merged chain collision, animated tiles, autotile terrains and the paint editor.

## Decisions

- Not Babylon `SpriteMap`: that format cannot golden-test geometry or emit collision chains.
- Geometry and collision builders in `@haptic/assets` are pure and Babylon-free; callers pass world tile size (`px / pixelsPerUnit`) so assets never read project settings.
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
| Terrain masks, `canonicalTerrainMask`, `terrainMatchScore`, `createTerrainResolver`; standard layouts `AUTOTILE_LAYOUTS`; `missingTerrainVariants` | [`packages/assets/src/tileset-terrain.ts`](../../../packages/assets/src/tileset-terrain.ts) |
| Autotile authoring: piece sets, `assignAutotilePiece` / `clearAutotilePiece` / `removeTileFromAutotile`, `AUTOTILE_TEMPLATES` and their placement, `autotileLayoutChange`, test paint `autotileSandboxTiles` | [`packages/assets/src/tileset-autotile-templates.ts`](../../../packages/assets/src/tileset-autotile-templates.ts) |
| Terrain painting `paintTilemapTerrain`, `tilemapTerrainKeyOf`, `refreshTilemapTerrains` | [`packages/assets/src/tilemap-terrain.ts`](../../../packages/assets/src/tilemap-terrain.ts) |
| Meshes, atlas binding, parallax | [`packages/render/src/tilemap-mesh.ts`](../../../packages/render/src/tilemap-mesh.ts) |
| Physics chains (`SpriteTileColliders`) | [`packages/runtime/src/physics-sprite-tile-colliders.ts`](../../../packages/runtime/src/physics-sprite-tile-colliders.ts) |
| Animation clock (`tilemapAnimationTime`) | [`packages/runtime/src/runtime-tick-phases.ts`](../../../packages/runtime/src/runtime-tick-phases.ts) (advances it), [`runtime-composition-scene.ts`](../../../packages/runtime/src/runtime-composition-scene.ts) (`startWorld` resets it), [`driver.ts`](../../../packages/runtime/src/driver.ts) (`registerTileContent` re-sends it) |
| Editor providers | [`apps/editor/src/context/tilemap-editing-context.tsx`](../../../apps/editor/src/context/tilemap-editing-context.tsx), [`tileset-editing-context.tsx`](../../../apps/editor/src/context/tileset-editing-context.tsx), [`tilemap-tileset-payloads.ts`](../../../apps/editor/src/context/tilemap-tileset-payloads.ts) |

## Formats

- Tileset (`.tileset.hasset`, kind `tileset`): `textureGuid`, `atlasWidth/Height` (source pixels, needed before the texture loads), `tileWidth/Height`, `margin`, `spacing`, per-id `tiles` metadata (`collision` none / full / chain points, `flags`, `animation`, `animationFrameDurationMs`, optional `terrain`), optional `terrains`.
- Terrains: `terrains: [{ id, name, style: "sides" | "blob" }]` (unknown style → `sides`); a member tile has `terrain: { id, mask }`. Both keys are optional and omitted when empty, so older Tilesets decode unchanged (additive, no header version bump); normalize drops a membership whose terrain the Tileset does not define and clamps `mask` to 8 bits. `mask` stores raw bits so switching style keeps corner bits; the style's canonical form is applied when resolving.
- Mask bits, clockwise from north in +Y-up tile space: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128 (`TERRAIN_*`). Canonical `sides` keeps N/E/S/W (16 variants); canonical `blob` keeps a corner only when both adjacent sides are set (47 variants).
- Tile id 0 is empty; id 1 is the first atlas cell, row 0 at the image top.
- Tilemap (`.tilemap.hasset`, kind `tilemap`): Tiled-style `tilesets` `{ guid, firstGid, tileCount }`; cells store global GIDs (`firstGid + localId - 1`); `tileWidth/Height`; `width/height` in tiles (default 64×64); `chunkSize` (default 32); ordered `layers` with visibility, collision opt-in, sorting, parallax and sparse chunks.
- Chunk `{ cx, cy, tiles }`, `tiles.length === chunkSize²`, index `ly * chunkSize + lx`, (0,0) bottom-left, +Y up, XY plane. Empty cells and chunks are never allocated.
- `decodeTileGid` picks the highest `firstGid <= gid`; a map without tilesets owns no GIDs. `tileCount` never shrinks; `reconcileTilemapTilesets` relocates growing ranges and remaps cells as part of the next authored edit (so it undoes with it). Closed maps are never rewritten across documents.
- Removing a Tileset erases its painted cells without compacting other GIDs.

## Geometry and render

- One draw per chunk per atlas, tile 0 skipped; quad order BL, BR, TR, TL like sprite `CreatePlane`. Quads occupy exact grid cells; UVs inset half a texel so NEAREST never samples a neighbor.
- An atlas without a texture draws per-tile vertex colours (`tilePlaceholderHsl(gid)`, the same hue as the paint canvas) on one shared unlit, double-sided, fog-free Standard material per Scene (`applyTilemapAlbedoTextures`); chunks never keep Babylon's lit default material.
- Albedo uses a per-sampling-key `ResourceCache` wrapper (`PIXEL_ART_TEXTURE_SAMPLING`). Extra keys use another `createObjectURL` of the same Blob — never `#nomip` / `#ninv` fragments on `blob:` URLs; use explicit loader hints.
- Play builds `actor-N` plus one child per non-empty static chunk per atlas (`:a1`, `:a2` …) and an `:anim` sibling for animated tiles. Editor children are `editorActor:<id>:<layer>:<cx>:<cy>`; picking maps back to the actor.
- Animated tiles update only their UV buffers. Play, Simulate and Preview Build use the runtime `tilemapAnimationTime` (simulation time: pause holds, step advances, dilation scales). Editor views (`createEngine` without `playMode`) never advance it, so tiles keep their first frame, built at time 0. The binary snapshot format is unchanged.
- Parallax offset = camera × (1 − parallax), applied after camera posing and pixel snap via `updateSceneTilemapParallax`; overlay slots skip it.
- A Tilemap component is one sorting group; layers sort inside it by project sorting layer, `orderInLayer`, then list order. Depth testing stays on.
- Disposal or rebinding disposes the owned albedo material but never the shared cache texture.

## Terrains (autotile)

- A neighbour joins a cell when it holds a tile of the same terrain of the same Tileset (`tilemapTerrainKey`: guid + terrain id). Plain tiles and other terrains never join. Cells outside the map always join, so ground drawn to the map edge runs on past it instead of capping there.
- Resolution (`createTerrainResolver`): the member tile whose canonical mask equals the wanted canonical mask; otherwise the closest by `terrainMatchScore`, compared in order: (1) fewest wanted sides the tile draws open, (2) fewest open sides the tile draws joined, (3) fewest inner-corner notches the tile draws that the cell does not want, (4) fewest wanted notches the tile fills, (5) lowest tile id. Corner terms count only where the tile joins both adjacent sides. Order reason: an edge drawn inside the terrain is the most visible error, a cut-off edge less so, a notch least. Incomplete sheets therefore paint: missing bottom/side edges fall back to fill, a one-high strip keeps its top tiles. `maxTileId` limits members to the map's Tileset range.
- `paintTilemapTerrain` writes the brush terrain into the target cells (or 0 when erasing), then re-resolves every target and every terrain tile in their 8-neighbourhood against the new membership. Membership never changes for neighbours, so one pass is exact; incremental brush moves equal one batch write. Reads go through `TilemapChunkIndex` positions (or a per-call chunk map), across chunk borders and missing chunks; writes go through `setTiles`, so unchanged cells keep the same map object and out-of-bounds cells are never written.
- A stroke with `terrain` set routes every tool through it: Brush/Rect/Stamp paint terrain cells, Bucket fills the connected cells of the start cell's terrain (whatever their variants), or of its exact GID outside a terrain, and is a no-op on the brush's own terrain. The Eraser always erases through `paintTilemapTerrain(null)` when the Tilesets are loaded, terrain brush or not, so neighbouring terrain tiles re-resolve. Single-tile strokes never re-resolve neighbours, so hand-placed variants stay.
- `refreshTilemapTerrains` re-resolves every terrain cell of every layer against its neighbours (the Tilemap **Refresh Autotiles** command, one edit); terrains that no longer exist or have no tiles leave their cells alone. Painted maps never re-resolve on their own when a Tileset changes.
- Standard layouts (`AUTOTILE_LAYOUTS`, row-major from the block's top-left): `sides` 4 × 4 is a 3 × 3 island, a vertical strip, a horizontal strip and a single; `blob` 12 × 4 is that island with every inner corner filled in columns 1-4, then the 31 notched variants in ascending mask order, column-major over columns 5-12, one cell `null`. The Autotiles board lays pieces out in this order.
- Piece sets: authoring works on `AutotilePieceSet` `{ terrainId, border? }`; a tile belongs to a set when its membership has that terrain and border. Assigning keeps one tile per canonical piece (other tiles of the set with that piece lose membership, a tile of another set moves over), spreads the tile's existing membership so unknown fields survive, and writes the set's `border`. 4 Sides pieces store their corners filled so a switch to Blob reads them as the solid island. Nothing re-resolves on Layout change: tiles keep raw masks; `autotileLayoutChange` reports kept, missing and unused (a second tile of one piece) for the confirm.
- Templates (`AUTOTILE_TEMPLATES`, pure data, canonical masks, row 0 = north): both full blocks, then Island (Blob with filled corners), strips, Single, and for Blob the 2 × 2 inner-corner blocks Hole (notches toward the centre) and Outward. `applyAutotileTemplate` assigns every non-`null` cell as `assignAutotilePiece` would and counts replaced memberships; a placement running past the atlas returns `null`.
- Test paint (`autotileSandboxTiles`) paints the window's 14 × 9 sample through `paintTilemapTerrain` on an in-memory map in one batch (equal to any stroke order), so it matches the Tilemap brush; a cell whose tile's canonical piece differs from the wanted one is a stand-in.

## Collision

- `tilemapLayerChains` merges `full` tiles across all chunks of a layer in integer grid space before scaling: a solid rectangle is one four-point loop with no seams at chunk borders. Custom chain tiles emit open polylines.
- `PhysicsWorldSync` gives every `TilemapComponent` actor a static body and attaches chains only for layers with `collision: true`. Rapier closed loops use an indexed closing segment; repeating the first point makes raycasts miss.
- Nav bake and editor Drop use the same chains (`tilemapCollisionChains`).

## Editor rules

- Tileset and Tilemap are DockView documents with Windows enabled (Tileset: Preview primary, Autotiles as a tab in the Preview's group, Inspector; Tilemap: Paint primary, Palette, Inspector). Default tool is Move; two-finger pinch/pan works in every tool and a second finger drops an in-progress stroke without committing.
- One document edit per stroke: the stroke previews locally and commits on release or cancel with merge key `tilemap-stroke:<id>`. Unchanged strokes commit nothing. `setTiles` copies each touched chunk once and returns the same map when nothing changed.
- Tile Width/Height use local drafts committed by **Confirm Tile Size** to avoid rebuilding the atlas per keystroke.
- The UI calls terrains **Autotiles**; code, data and tests keep `terrain`. All authoring lives in the **Autotiles** window ([`tileset-autotiles-window.tsx`](../../../apps/editor/src/components/tileset-autotiles-window.tsx)), which works alone (phones show one window) because it has its own `AtlasTileGrid` of the sheet. The Inspector shows only the count and **Edit Autotiles** (opens the window if closed, then activates it); the Preview has only Move and Select, so Paint Collision is the only thing a Preview tap edits.
- Window: **New Autotile** is a dialog with a unique Name and a required Layout; the ⋯ menu renames, changes Layout (an AlertDialog with `autotileLayoutChange` when tiles are assigned) and deletes (undoable; confirmed when tiles are assigned; membership cleared in the same edit). The board selects a slot (default: first empty in board order); a sheet tap assigns to it and advances to the next empty slot; with no slot selected a sheet tap picks a tile for the next slot tap. Slot menu: **Clear Piece**, **Show On Sheet** (reveals the tile); sheet tile menu: **Remove From Autotile**. Template placement draws the template as the grid's `overlay`, moves by tap (refused past the atlas) or `tileDrag` (clamped), and applies in one edit. Test paint is local state per autotile and style.
- Every window edit is one undo step with merge key `tileset:autotile:<id>:<op>…` (`piece:<mask>:<tile>`, `clear:<mask>`, `remove:<tile>`, `template:<id>:<anchor>`, `create`, `name`, `layout:<style>`, `delete`); edits that change nothing commit nothing. `TilesetEditingProvider` shares `selectedAutotileId`, the tile selection, Paint Collision and the Preview tool.
- The Palette lists every autotile of the map's Tilesets first (fill tile from `terrainFillMask`, coverage "n of total"); one with no tiles is a **Set Up in Tileset** button (`useAssetOpen`). `TilemapEditingProvider.selectedTerrain` is the terrain brush and selecting a tile clears it; selecting a terrain while Move or Picker is active switches TilemapPaint to Brush, and the Picker on a terrain cell selects that terrain. Strokes capture the brush and the loaded Tileset payloads at pointer-down and keep the one-edit-per-stroke commit.
- Panels share one Tileset payload map from `TilemapEditingProvider`, cached per source object; painting never reads Tilesets from storage.
- The Create Project 2D card stays minimal (2D viewport and physics, no default cube, pixel-perfect on); do not turn it into a demo scene.
