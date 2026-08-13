# Tilemaps (P10)

Tileset and Tilemap assets, chunked `VertexData`, and (later in the slice) merged Rapier chain colliders plus touch painting (engineplan §13.3). Not Babylon `SpriteMap` — that format cannot golden-test geometry or emit collision chains.

Autotile and terrain rules are deferred.

## Assets

### Tileset

Document kind `tileset` (`.tileset.babasset`). Payload in `@babylonslate/assets`:

| Field | Role |
| --- | --- |
| `textureGuid` | atlas texture |
| `atlasWidth` / `atlasHeight` | source pixels (needed for UVs before the texture loads) |
| `tileWidth` / `tileHeight` | cell size in pixels |
| `margin` / `spacing` | Tiled-style atlas layout |
| `tiles` | per-id metadata: `collision` (`none` \| `full` \| chain points), `flags`, `animation` |

Tile **id 0 is empty**. Id 1 is the first atlas cell (row 0 at the **top** of the image). `tilesetTileUv` flips V so GL `v=0` is the bottom of the texture.

### Tilemap

Document kind `tilemap` (`.tilemap.babasset`):

| Field | Role |
| --- | --- |
| `tilesetGuid` | Tileset asset |
| `tileWidth` / `tileHeight` | cell size in pixels (world size = px / `pixelsPerUnit`) |
| `chunkSize` | default **32** |
| `layers` | ordered layers with visibility, collision opt-in, sorting, parallax, and chunks |

Each chunk is `{ cx, cy, tiles }` with `tiles.length === chunkSize²`. Local index `ly * chunkSize + lx`, **(0,0) bottom-left**, +Y up, XY plane (same 2D convention as the rest of the engine).

## Chunk geometry

`tilemapChunkVertexData` is a **pure**, Babylon-free function: tile ids + tileset → `{ positions, uvs, indices }`. One draw per chunk per atlas; tile 0 is skipped. Quad order matches sprite `CreatePlane`: BL, BR, TR, TL. Callers pass `worldTileWidth` / `worldTileHeight` (`px / pixelsPerUnit`, default PPU 100) so `@babylonslate/assets` does not read project settings.

Only **affected chunks** should be rebuilt on paint. Goldens live next to the packer fixtures (`UPDATE_GOLDENS=1`).

Animated tiles (tileset `animation` frame lists) draw as a small separate set; they do not make every static tile dynamic.

## Placement

`TilemapComponent` stays in `ENGINE_COMPONENT_CLASS_IDS`. Add Component / Search advertise it once Play loads chunk meshes and Rapier chain colliders (same PR wave). Properties: `assetGuid`, sorting layer / order.

## Painting (follow-up in this phase)

Brush, eraser, rect, bucket, stamp, picker; palette as a bottom `Sheet`; one-finger paint / two-finger pan; **one undo per stroke** via `SetAssetDocumentCommand.mergeKey`. See [command-layer.md](command-layer.md).

## Alpha test vs blend

Sprites default to alpha **test** (opaque pass, no transparency sort). Whether that is also right for a dense tilemap on an A16 is a **device measurement**, not a default lock. CI `NullEngine` cannot produce fill-rate numbers; record an on-device profile before changing the sprite/tilemap default. Until then, chunks use the same alpha-test path as sprites.

## Related

[sprites.md](sprites.md), [physics.md](physics.md), [render.md](render.md), [scene-editing.md](scene-editing.md).
