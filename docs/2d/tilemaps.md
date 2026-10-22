# Tilemaps

Paint 2D levels from a grid of tiles. A **Tileset** slices an image into tiles and says which ones are solid, a **Tilemap** holds the painted layers, and a Tilemap component places the map in a scene.

## Make a Tileset

1. Import your tile sheet as a Texture. See [Importing](../editor/importing.md).
2. In the **Content Browser**, choose **New Asset > 2D > Tileset**, then double-tap it.
3. Tap **Pick Texture** in the **Preview**, or set **Texture** in the **Inspector**. **Atlas Width** and **Atlas Height** fill in from the image.
4. Set **Tile Width** and **Tile Height** in pixels (default 16), then tap **Confirm Tile Size**. Set **Margin** (border around the sheet) and **Spacing** (gap between tiles) if your sheet has them.

Tiles are numbered from 1, starting at the top-left of the image. In the **Preview**, **Move** pans with one finger and **Select** drags a box to select several tiles. Pinch or scroll to zoom in either tool.

## Tile settings

Select one or more tiles, then edit them in the **Inspector**. Edits apply to every selected tile.

| Setting | Description |
| --- | --- |
| Tile Collision | **None**, **Full** (the whole cell is solid) or **Chain** (a solid line through **Chain Points**). Also on the **Preview** toolbar. |
| Chain Points | For Chain collision: points written as `x,y x,y …` in tile units, from 0,0 at the tile's bottom-left to 1,1 at its top-right. |
| Tile Flags | Eight on/off flags stored with the tile. |
| Animation Frames | Tile numbers to cycle through, separated by commas. Leave empty for a still tile. |
| Frame Duration | Length of each animation frame. Default 100. |
| Terrain, Terrain Neighbours | Put the tile in a terrain and mark where its artwork continues. See [Terrains](#terrains). |

Turn on **Paint Collision** in the **Preview** toolbar to copy the current tile's collision onto each tile you tap or select.

## Terrains

A terrain paints edges and corners for you. Instead of placing each left end, top and corner piece by hand, you paint with the terrain and every cell takes the tile that matches its neighbours.

1. In the Tileset's **Inspector**, under **Terrains**, tap **Add Terrain** and choose its **Style**: **4 Sides (16)** matches the four side neighbours; **Blob (47)** also matches corners and gives inner corners.
2. Select the terrain's tiles and set **Terrain** on them.
3. For each tile, press the **Terrain Neighbours** its artwork continues into.

Your sheet does not need every piece. Where one is missing, the terrain paints the closest tile it has, preferring a tile that draws no edge inside the terrain. The [Tileset](../assets/tileset.md#terrains) page has the details.

## Paint a Tilemap

1. Choose **New Asset > 2D > Tilemap**, then double-tap it. **Paint** fills the centre, with **Palette** on the left and the **Inspector** on the right.
2. Under **Tilesets** in the **Inspector**, tap **Add Tileset**. A map can use several Tilesets.
3. Tap a tile in the **Palette**. Use **Search Tiles** to filter long lists.
4. Pick a tool in the **Paint** toolbar, choose the layer in the **Paint Layer** picker, and paint.

| Tool | Effect |
| --- | --- |
| Move | Pans the map. The default tool. |
| Brush, Eraser | Paint or erase tiles under your finger. |
| Rect | Fills the rectangle you drag. |
| Bucket | Fills the connected area of matching tiles. |
| Stamp | Places a 2 × 2 block of the selected tile. |
| Picker | Picks the tile you tap as the brush. |

One finger paints. Two fingers pinch to zoom and drag to pan in any tool; the scroll wheel zooms. Each stroke is one undo step.

## Paint with terrains

1. In the **Palette**, tap a terrain. Terrains sit above their Tileset's tiles, and the **Paint** toolbar shows the terrain's name.
2. Paint with **Brush**, **Rect**, **Bucket** or **Stamp**. The cells you paint, and the terrain tiles around them, switch to the pieces that fit. The whole stroke is still one undo step.
3. Use the **Eraser** to clear cells; the terrain tiles around them update too.
4. Tap a single tile, or tap the terrain again, to go back to painting single tiles.

- Only tiles of the same terrain join. Single tiles and other terrains count as empty.
- Beyond the edge of the map counts as the same terrain, so ground painted up to the edge carries on past it.
- **Bucket** with a terrain fills the connected tiles of the terrain you tap, whatever their pieces.
- Painting single tiles never changes the tiles around them, so you can place a special piece by hand.
- Changing a terrain in its Tileset does not repaint existing maps. Paint over the cells to update them.

## Map and layer settings

| Setting | Description |
| --- | --- |
| Map Width, Map Height | Map size in tiles. Default 64 × 64. Shrinking the map removes tiles outside it. |
| Tile Width, Tile Height | Cell size in pixels (default 16). World size is this divided by **Pixels Per Unit**. Usually the same as the Tileset's tile size. |
| Chunk Size | Tiles per side of each internal block. Default 32. |

**Layers** lists the map's layers. Tap **Add Layer** to add one, tap a layer to edit it, and use its eye button to hide or show it. Under **Selected Layer**:

| Setting | Description |
| --- | --- |
| Layer Name | The layer's name. |
| Visible | Hidden layers keep their tiles but do not draw, in the editor or the game. |
| Collision | Makes this layer's solid tiles collide. On for new layers. |
| Sorting Layer, Order In Layer | Draw order of this layer within the map. |
| Parallax | How far the layer moves with the camera in Play. 1 stays fixed to the world, 0 follows the camera, values between scroll more slowly. Default 1, 1. |

## Place a tilemap

In **Place Actors**, choose **Rendering > Tilemap** and set **Asset** on its Tilemap component, or pick your Tilemap under **Content > Project**. Cell 0, 0 sits at the actor's position, and the map extends right and up. Tilemaps work in scenes and in Scene Layers.

The [Tilemap](../components/tilemap.md) component's **Sorting Layer** and **Order In Layer** place the whole map among other sprites; the map's own layers sort inside it.

## Collision

Each layer with **Collision** on becomes solid ground from its Full and Chain tiles, with no Rigid Body or Collider needed. Neighbouring Full tiles merge into one outline, so characters slide along a floor without catching on tile edges. Turn **Collision** off for background and decoration layers. Use a scene whose **Physics World** is **2D (Rapier)**.

## Things to know

- **Bucket** spreads only through the part of the layer that already has tiles. On an empty layer it fills one cell.
- Removing a Tileset from a map erases its tiles from every layer. The editor asks first, and you can undo it.
- Animated tiles play in the scene viewport and in Play, and pause when the game pauses.
- Parallax applies only in Play, not in the editor viewport.

## Related

- [Tileset](../assets/tileset.md)
- [Tilemap](../assets/tilemap.md)
- [Sprites](sprites.md)
- [2D](index.md)
