# Tilemaps (P10)

Tileset and Tilemap assets, chunked `VertexData`, merged Rapier chain colliders, and (later in the slice) touch painting (engineplan §13.3). Not Babylon `SpriteMap` — that format cannot golden-test geometry or emit collision chains.

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

Only **affected chunks** are copied in `setTile`. Editor and Play mesh builders still walk every **visible** chunk when the document or scene applies.

Animated tiles (tileset `animation` frame lists) draw as a small separate set; they do not make every static tile dynamic.

Play builds a parent `actor-N` mesh plus one child draw per non-empty static chunk, plus an `:anim` sibling when the chunk has animated tiles (`createTilemapMeshes`). Chunk children are named `editorActor:<id>:<layer>:<cx>:<cy>` (optional `:anim`). Editor picking maps those names back to the actor id; Play picking still walks parents to `actor-N`.

`tilemapChunkVertexData({ kind: "static" | "animated" })` splits the draw: animated tileset ids (`animation.length > 0`) use the first frame’s UVs on the `:anim` mesh. Per-layer `sortingLayer` / `orderInLayer` write `renderingGroupId` / `alphaIndex`. `parallax` is stored on child `metadata` and applied in Play against the active camera (`tilemapParallaxOffset`).

## Collision

`tilemapChunkChains` (also Babylon-free) merges `full` tiles in a chunk: shared edges cancel, collinear outer edges collapse, so a solid rectangle is **one four-point loop** rather than a box per tile. Custom `chain` collision on a tile is emitted as an open polyline in world space.

`PhysicsWorldSync` gives every `TilemapComponent` actor a **static** body (even without `RigidBodyComponent`) and attaches those chains for layers with `collision: true`. Software 2D treats a chain as its AABB (wasm-failure path); Rapier uses real chain colliders. Closed Rapier loops get a closing **segment** collider (repeating the first polyline point makes Rapier miss raycasts).

Play loads Tilemap / Tileset payloads from scene `TilemapComponent.assetGuid` values (not only open tabs) and posts worker `loadTilemaps` before `play`. Project `twoD.pixelsPerUnit` sizes both meshes and chains. Chunk meshes bind the tileset `textureGuid` through `ResourceCache` when texture bytes were collected, with the same **alpha-test** unlit material as sprites (`alphaCutOff` 0.4). When `twoD.pixelPerfect` is on, Play snaps the **game** camera to the pixel grid; the editor pan/zoom camera stays continuous (§13.5). Play e2e (`e2e/p10-tilemap.spec.ts`) starts from the 2D Create Project card, paints tiles, binds a Sprite with its default Idle clip, and asserts `physicsMs > 0`, `play-fps > 0`, and a dynamic actor starting at Y=3 settling on the painted tiles (`play-actor-y`). It does **not** claim A16 fill-rate or shimmer-free scrolling.

## Placement

`TilemapComponent` is in Add Component (Rendering) and Search. Properties: `assetGuid`, sorting layer / order.

## Authoring

Tileset and Tilemap documents are DockView shells (**Windows** enabled):

| Kind | Primary | Details |
| --- | --- | --- |
| Tileset | Preview (atlas) | Texture, grid, **selected tile** collision (`none` / `full` / `chain` points), flags, animation frame ids |
| Tilemap | Paint | Tileset, size, **layer list** (add/reorder/remove) with visibility, collision, sorting, parallax |

Paint: brush, eraser, rect, bucket, stamp, picker (`ToggleGroup` + `SearchDropdown` palette). One finger paints; two fingers pan (`touch-none`). **One undo per stroke** via `SetAssetDocumentCommand.mergeKey` (`tilemap-stroke:<id>`). `applyTilemapPaint` is the pure op; `setTile` only rebuilds the touched chunk. The paint canvas draws the tileset atlas when a Texture is assigned, otherwise HSL placeholders.

Stamp places a 2×2 of the selected tile. Bucket is 4-connected and stays inside the AABB of existing chunks (plus the click cell).

The Create Project dialog has a built-in **2D** card (`create-project-2d`) next to Empty: `viewportMode` / `physicsWorld` 2d, no default cube, `pixelPerfect` + `integerZoomSteps` on. Do not expand that card into a demo scene.

## Alpha test vs blend

Sprites default to alpha **test** (opaque pass, no transparency sort). Whether that is also right for a dense tilemap on an A16 is a **device measurement**, not a default lock. CI `NullEngine` cannot produce fill-rate numbers; record an on-device profile before changing the sprite/tilemap default. Until then, chunks use the same alpha-test path as sprites.

## Related

[sprites.md](sprites.md), [physics.md](physics.md), [render.md](render.md), [scene-editing.md](scene-editing.md).
