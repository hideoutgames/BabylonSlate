# Tilemaps (P10)

Tileset and Tilemap assets, chunked `VertexData`, merged Rapier chain colliders, and touch painting (engineplan §13.3). Not Babylon `SpriteMap` — that format cannot golden-test geometry or emit collision chains.

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

Tile **id 0 is empty**. Id 1 is the first atlas cell (row 0 at the **top** of the image). `tilesetTileRect` is the image-space source rect (margin/spacing) used by Paint (`drawImage`). `tilesetTileUv` uses that rect, flips V so GL `v=0` is the bottom of the texture, and **insets by half a texel** so scene/Play chunk sampling does not sit on a shared atlas edge (zoom-dependent black seams / alpha-test holes). `atlasCellAt` maps a pointer on a scaled atlas view to a 1-based tile id (0 if outside).

### Tilemap

Document kind `tilemap` (`.tilemap.babasset`):

| Field | Role |
| --- | --- |
| `tilesets` | Tiled-style list of `{ guid, firstGid, tileCount }`. Chunk cells store **global GIDs** (`firstGid + localId - 1`). Removing a tileset does **not** compact GIDs. |
| `tilesetGuid` | Writable alias of `tilesets[0]?.guid` (legacy maps migrate to one ref at `firstGid: 1`) |
| `tileWidth` / `tileHeight` | cell size in pixels (world size = px / `pixelsPerUnit`) |
| `width` / `height` | map size in tiles, +Y up, origin bottom-left. Default **64×64**. Storage stays sparse chunks — empty cells are not allocated. |
| `chunkSize` | default **32** |
| `layers` | ordered layers with visibility, collision opt-in, sorting, parallax, and chunks |

Each chunk is `{ cx, cy, tiles }` with `tiles.length === chunkSize²`. Local index `ly * chunkSize + lx`, **(0,0) bottom-left**, +Y up, XY plane (same 2D convention as the rest of the engine). `setTile` / `applyTilemapPaint` no-op outside `[0, width) × [0, height)`. Missing `width`/`height` on load migrate to `max(64, painted AABB + 1)`. `resizeTilemap` clamps to ≥1 and **clips** tiles (then empty chunks) on shrink. Play/render/physics still skip tile 0 and missing chunks — no mesh format change.

## Chunk geometry

`tilemapChunkVertexData` is a **pure**, Babylon-free function: GIDs + a GID resolver → `{ positions, uvs, indices }`. One draw per chunk **per atlas**; tile 0 is skipped. Callers pass `atlasGuid` to emit only that tileset’s quads. Quad order matches sprite `CreatePlane`: BL, BR, TR, TL. Callers pass `worldTileWidth` / `worldTileHeight` (`px / pixelsPerUnit`, default PPU 100) so `@babylonslate/assets` does not read project settings.

`encodeTileGid` / `decodeTileGid(map, gid, tilesetPayloads)` pick the highest `firstGid <= gid`. Play/editor/physics all use the same helpers. Legacy maps with an empty `tilesets[]` and only `tilesetGuid` still treat GIDs as local ids.

Only **affected chunks** are copied in `setTile`. Editor and Play mesh builders still walk every **visible** chunk when the document or scene applies.

Animated tiles (tileset `animation` frame lists) draw as a small separate set; they do not make every static tile dynamic.

Play builds a parent `actor-N` mesh plus one child draw per non-empty static chunk **per atlas**, plus an `:anim` sibling when the chunk has animated tiles (`createTilemapMeshes`). Extra atlases append `:a1`, `:a2`, … Children store `metadata.tilemapTextureGuid` so `applyTilemapAlbedoTextures` can bind each atlas. Chunk children are named `editorActor:<id>:<layer>:<cx>:<cy>` (optional `:aN` / `:anim`). Editor picking maps those names back to the actor id; Play picking still walks parents to `actor-N`.

`tilemapChunkVertexData({ kind: "static" | "animated" })` splits the draw: animated tileset ids (`animation.length > 0`) use the first frame’s UVs on the `:anim` mesh. Per-layer `sortingLayer` / `orderInLayer` write `renderingGroupId` / `alphaIndex`. `parallax` is stored on child `metadata` and applied in Play against the active camera (`tilemapParallaxOffset`).

## Collision

`tilemapChunkChains` (also Babylon-free) merges `full` tiles in a chunk: shared edges cancel, collinear outer edges collapse, so a solid rectangle is **one four-point loop** rather than a box per tile. Custom `chain` collision on a tile is emitted as an open polyline in world space.

`PhysicsWorldSync` gives every `TilemapComponent` actor a **static** body (even without `RigidBodyComponent`) and attaches those chains for layers with `collision: true`. Layers with `collision: false`, a missing `assetGuid`, or a missing tileset payload produce no chain colliders. Software 2D treats a chain as its AABB (wasm-failure path); Rapier uses real chain colliders. Closed Rapier loops get a closing **segment** collider (repeating the first polyline point makes Rapier miss raycasts).

Play loads Tilemap / Tileset payloads from scene `TilemapComponent.assetGuid` values (not only open tabs) and posts worker `loadTilemaps` before `play`. Project `twoD.pixelsPerUnit` sizes both meshes and chains. Chunk meshes bind each tileset `textureGuid` through `ResourceCache` when texture bytes were collected, with the same **alpha-test** unlit material as sprites (`alphaCutOff` 0.4). When `twoD.pixelPerfect` is on, Play snaps the **game** camera to the pixel grid; the editor pan/zoom camera stays continuous (§13.5). Play e2e (`e2e/p10-tilemap.spec.ts`) starts from the 2D Create Project card, paints from a Palette GID after closing the Tileset tab, pinches the painter, binds a Sprite with its default Idle clip, and asserts `physicsMs > 0`, `play-fps > 0`, and a dynamic actor starting at Y=3 settling on the painted tiles (`play-actor-y`). It does **not** claim A16 fill-rate or shimmer-free scrolling.

## Placement

`TilemapComponent` is in Add Component (Rendering) and Search. Properties: `assetGuid`, sorting layer / order.

## Authoring

Tileset and Tilemap documents are DockView shells (**Windows** enabled):

| Kind | Docks |
| --- | --- |
| Tileset | **Preview** (clickable pixel-aligned atlas) + **Details** (Atlas + Selected Tile) |
| Tilemap | **Paint** (primary) + **Palette** (left, ~280px) + **Details** (Tilesets list + layers) |

### Tileset

- Preview fills the panel (`object-contain` atlas, grid from `tileWidth/Height`, `margin`, `spacing` in **texture space** — not a CSS grid of `tiles.length`).
- Toolbar: **Move** (default, Lucide `HandIcon`) | **Select**, then None / Full / Chain and **Paint Collision**. In Move, one-finger drag pans; a tap (movement < 8px) still selects. In Select, tap a cell as before. Two-finger pinch/pan and wheel zoom stay in both tools. `tileset-preview-cell-{id}`. Full cells show a hatch; Chain draws the stored polyline on the selected cell.
- `Empty` when no Texture is assigned.
- Picking a Texture sets `atlasWidth/Height` from `img.naturalWidth/Height` and runs `ensureTilesetTiles`. Atlas size fields in Details are read-only.

### Tilemap

- **Tilesets** is a `NamedListEditor` (`Add Tileset` opens `AssetPicker`). Rows use `PickerIdentity`. Empty copy: “Add a Tileset to start painting.” Several tilesets share one GID space on the map — not one tileset per layer.
- **Palette** loads each listed tileset with `loadAssetDocument` (closed tabs included) plus Texture `pixels`. Thumbs are cropped with `tilesetTileRect` and nearest-neighbor, grouped by tileset name. Tap sets the paint GID. `SearchInput` filters large sets. The Paint toolbar shows a 44px selected-tile thumb (`data-gid` / `data-tile`), not a text Palette dropdown.
- **Paint** fills `PanelFrame` (`ResizeObserver` backing store, `devicePixelRatio`). Blit with `imageSmoothingEnabled = false` and draw the grid **only inside** the map rectangle (full cell, no gutters) with a high-contrast bounds stroke; outside stays the dark canvas. Empty in-bounds cells stay empty. Default tool is **Move** (`HandIcon`, `data-tool="move"`); switch to Brush to paint. One-finger drag pans in Move. Other tools (brush/eraser/rect/bucket/stamp/picker) still one-finger paint. Two-finger pinch zooms about the midpoint and translation pans in every tool; a second finger drops an in-progress paint stroke (reverts it) so pinch does not leave a stray tile. Wheel zooms about the cursor. Cell size is clamped 8–96 CSS px (default 32). `data-cell-size` / `data-zoom` / `data-pan-x` / `data-pan-y` / `data-paint-source` (`atlas` \| `hsl`) are for Playwright. No tilesets → `Empty` instead of a blank square.
- Details **Map** group: Map Width / Map Height (`property-mapWidth` / `property-mapHeight`) with Tile Width/Height.
- **One undo per stroke** via `SetAssetDocumentCommand.mergeKey` (`tilemap-stroke:<id>`). `applyTilemapPaint` is the pure op; `setTile` only rebuilds the touched chunk.

Stamp places a 2×2 of the selected GID. Bucket is 4-connected and stays inside the AABB of existing chunks (plus the click cell).

The Create Project dialog has a built-in **2D** card (`create-project-2d`) next to Empty: `viewportMode` / `physicsWorld` 2d, no default cube, `pixelPerfect` + `integerZoomSteps` on. Do not expand that card into a demo scene.

## Alpha test vs blend

Sprites default to alpha **test** (opaque pass, no transparency sort). Whether that is also right for a dense tilemap on an A16 is a **device measurement**, not a default lock. CI `NullEngine` cannot produce fill-rate numbers; record an on-device profile before changing the sprite/tilemap default. Until then, chunks use the same alpha-test path as sprites.

## Related

[sprites.md](sprites.md), [physics.md](physics.md), [render.md](render.md), [scene-editing.md](scene-editing.md).
