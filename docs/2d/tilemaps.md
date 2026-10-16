# Tilemaps

Paint 2D levels from a grid of tiles. A **Tileset** slices an image into tiles and says which ones are solid, a **Tilemap** holds the painted layers, and a Tilemap component places the map in a scene.

## Make a Tileset

1. Import your tile sheet as a Texture. See [Importing](../editor/importing.md).
2. In the **Content Browser**, choose **New Asset > 2D > Tileset**, then double-tap it.
3. Tap **Pick Texture** in the **Preview**, or set **Texture** in the **Inspector**. **Atlas Width** and **Atlas Height** fill in from the image.
4. Set **Tile Width** and **Tile Height** in pixels (default 16), then tap **Confirm Tile Size**. Set **Margin** (border around the sheet) and **Spacing** (gap between tiles) if your sheet has them.

Tiles are numbered from 1, starting at the top-left of the image. In the **Preview**, **Move** pans with one finger and **Select** drags a box to select several tiles. Pinch or scroll to zoom in either tool.

### Tile settings

Select one or more tiles, then edit them in the **Inspector**. Edits apply to every selected tile.

| Setting | Description |
| --- | --- |
| Tile Collision | **None**, **Full** (the whole cell is solid) or **Chain** (a solid line through **Chain Points**). Also on the **Preview** toolbar. |
| Chain Points | For Chain collision: points written as `x,y x,y …` in tile units, from 0,0 at the tile's bottom-left to 1,1 at its top-right. |
| Tile Flags | Eight on/off flags stored with the tile. |
| Animation Frames | Tile numbers to cycle through, separated by commas. Leave empty for a still tile. |
| Frame Duration MS | Length of each animation frame. Default 100. |

Turn on **Paint Collision** in the **Preview** toolbar to copy the current tile's collision onto each tile you tap or select.

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
