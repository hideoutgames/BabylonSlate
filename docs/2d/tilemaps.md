# Tilemaps

Paint 2D levels from a grid of tiles. A **Tileset** slices an image into tiles and says which ones are solid, a **Tilemap** holds the painted layers, and a Tilemap component places the map in a scene.

## Make a Tileset

1. Import your tile sheet as a Texture. See [Importing](../editor/importing.md).
2. In the **Content Browser**, choose **New Asset > 2D > Tileset**, then double-tap it.
3. Tap **Pick Texture** in the **Preview**, or set **Texture** in the **Inspector**. **Atlas Width** and **Atlas Height** fill in from the image.
4. Set **Tile Width** and **Tile Height** in pixels (default 16), then tap **Confirm Tile Size**. Set **Margin** (border around the sheet) and **Spacing** (gap between tiles) if your sheet has them.

Tiles are numbered from 1, starting at the top-left of the image. In the **Preview**, **Move** pans with one finger and **Select** drags a box to select several tiles. Pinch or scroll to zoom in either tool. With a keyboard, Tab to the sheet, move between tiles with the arrow keys (Home and End go to the ends of a row) and press Enter or Space to select one.

## Tile settings

Select one or more tiles, then edit them in the **Inspector**. Edits apply to every selected tile.

| Setting | Description |
| --- | --- |
| Tile Collision | **None**, **Full** (the whole cell is solid) or **Chain** (a solid line through **Chain Points**). Also on the **Preview** toolbar. |
| Chain Points | For Chain collision: points written as `x,y x,y …` in tile units, from 0,0 at the tile's bottom-left to 1,1 at its top-right. |
| Tile Flags | Eight on/off flags stored with the tile. |
| Animation Frames | Tile numbers to cycle through, separated by commas. Leave empty for a still tile. |
| Frame Duration | Length of each animation frame. Default 100. |

Turn on **Paint Collision** in the **Preview** toolbar to copy the current tile's collision onto each tile you tap or select.

## Autotiles

An autotile paints edges and corners for you. Instead of placing each left end, top and corner piece by hand, you paint with the autotile and every cell takes the tile that matches its neighbours.

1. Open the Tileset's **Autotiles** window (a tab beside the **Preview**, or **Edit Autotiles** in the **Inspector**), tap **+** beside **Autotiles** and name the new autotile. Choose its **Layout**: **4 Sides** (16 pieces) follows the four side neighbours; **Blob** (47 pieces) also follows corners and gives inner corners.
2. Tap a piece, then its tile on the sheet; the next empty piece is selected for you. Where the sheet draws a whole group in the usual arrangement, tap the group's block button and then the block's top-left tile.
3. Each group shows how many pieces have a tile, and **Preview** shows the result: tap its cells to try shapes. Cells that use a nearby piece for a missing one carry an amber dot.

Your sheet does not need every piece. Where one is missing, the autotile paints the closest tile it has, preferring a tile that draws no edge inside it. The [Tileset](../assets/tileset.md#autotiles) page has the details.

Two autotiles of the same Tileset, such as grass and dirt, can meet through a transition: a set of pieces drawn against the other autotile. See [Transitions](../assets/tileset.md#transitions).

## Paint a Tilemap

1. Choose **New Asset > 2D > Tilemap**, then double-tap it. **Paint** fills the centre, with **Palette** on the left and the **Inspector** on the right.
2. Under **Tilesets** in the **Inspector**, tap **Add Tileset**. A map can use several Tilesets.
3. Tap a tile in the **Palette**. Use **Search Tiles** to filter long lists.
4. Pick a tool in the **Paint** toolbar, choose the layer in the **Paint Layer** picker, and paint. The picker and the layer selected in the **Inspector** are the same layer; when it is hidden, the toolbar shows **Layer Hidden**.

| Tool | Effect |
| --- | --- |
| Move | Pans the map. The default tool. |
| Select | Selects placed tiles to move, cut, copy, paste or delete them. |
| Brush, Eraser | Paint or erase tiles under your finger. |
| Rect | Fills the rectangle you drag. An outline shows it until you lift your finger. |
| Bucket | Fills the connected area of matching tiles, up to the edge of the map. On an unbounded map, up to 16 cells past the layer's painted tiles. |
| Stamp | Places a 2 × 2 block of the selected tile. |
| Picker | Picks the tile you tap as the brush. |

One finger paints. Two fingers pinch to zoom and drag to pan in any tool; the scroll wheel zooms. Each stroke is one undo step. With a mouse, the toolbar shows the column and row of the cell under the pointer.

## Move painted tiles

Use **Select** to move tiles you have already painted, for example after making a map larger:

1. In **Paint**, pick **Select**. Drag across cells to select them, or tap **Select All**. Turn on **All Layers** to move the tiles of every layer together.
2. Drag from inside the selection to move it, or nudge it with the arrow keys (<kbd>Shift</kbd> moves eight cells). Each drag is one undo step.
3. Long-press or right-click for **Cut**, **Copy**, **Paste** and **Delete**. A paste floats until you drag it into place and tap.

Moved tiles replace what is where they land, and autotile edges around them update. On a map with a size, tiles moved past the edge are cut off. See [Select and move tiles](../assets/tilemap.md#select-and-move-tiles) for every option and shortcut.

Your edits show in the Scene viewport as you make them, without saving first.

## Paint with autotiles

1. In the **Palette**, tap an autotile. **Autotiles** are listed first, each with its fill tile and its coverage. If the **Move** or **Picker** tool is active, the **Paint** toolbar switches to **Brush**.
2. Paint with **Brush**, **Rect**, **Bucket** or **Stamp**. The cells you paint, and the autotile tiles around them, switch to the pieces that fit. The whole stroke is still one undo step.
3. Use the **Eraser** to clear cells. The autotile tiles around them update, whatever the brush.
4. Tap a single tile, or tap the autotile again, to go back to painting single tiles.

- An autotile with no tiles yet shows **Set Up in Tileset**, which opens its Tileset.
- The **Picker** on an autotile cell picks the autotile, not the single tile.
- Only tiles of the same autotile join. Single tiles count as empty, and so do other autotiles unless the Tileset has a [transition](../assets/tileset.md#transitions) between the two.
- Beyond the edge of the map counts as the same autotile, so ground painted up to the edge carries on past it. An unbounded map has no edge: its outermost autotile tiles draw their edges.
- **Bucket** with an autotile fills the connected tiles of the autotile you tap, whatever their pieces.
- Painting single tiles never changes the tiles around them, so you can place a special piece by hand. It stays until one of its Tileset's autotiles changes.
- Changing an autotile in its Tileset repicks the autotile cells of every map that uses it, on every layer. The open Tilemap shows the new pieces at once and saves them with your next edit; the viewport, Play and exported games show them too.

## Map and layer settings

| Setting | Description |
| --- | --- |
| Unbounded | Removes the map's size, so you can paint in every direction. Default off. See [Unbounded tilemaps](#unbounded-tilemaps). |
| Map Width, Map Height | Map size in tiles. Default 64 × 64. Shrinking the map removes tiles outside it. Bounded maps only. |
| Pivot | The point of the map, in tiles, that sits at the actor's position. Moves in half-tile steps. Default 0, 0. **Center Pivot** moves it to the middle of the painted tiles. Unbounded maps only. |
| Painted Area | How many columns and rows the painted tiles cover. Unbounded maps only. |
| Tile Width, Tile Height | Cell size in pixels (default 16). World size is this divided by **Pixels Per Unit**. Usually the same as the Tileset's tile size. |
| Chunk Size | Tiles per side of each internal block. Default 32. Changing it keeps every tile in its cell. |

**Layers** lists the map's layers. Tap **Add Layer** to add one, tap a layer to edit it, and use its eye button to hide or show it. Under **Selected Layer**:

| Setting | Description |
| --- | --- |
| Layer Name | The layer's name. |
| Visible | Hidden layers keep their tiles but do not draw, in the editor or the game. |
| Collision | Makes this layer's solid tiles collide. On for new layers. |
| Sorting Layer, Order In Layer | Draw order of this layer within the map. |
| Parallax | How far the layer moves with the camera in Play. 1 stays fixed to the world, 0 follows the camera, values between scroll more slowly. Default 1, 1. |

## Unbounded tilemaps

A new map has a fixed size. Turn on **Unbounded** under **Map** in the **Inspector** for a map you can grow in every direction: you paint left of and below cell 0, 0 as freely as anywhere else, and the map is exactly as large as its painted tiles. The selection outline, framing the actor in the viewport and collision all follow the furthest tiles.

An unbounded map has a **Pivot**, the point of the map that sits at the actor's position:

1. **Paint** opens with the pivot in the middle of the view, drawn as a crosshair over the tiles. Paint around it in any direction.
2. Drag the crosshair to move the pivot, in half-tile steps. Each drag is one undo step and paints nothing; a tap on it paints as usual. With **Select**, a drag there selects tiles instead.
3. Or set **Pivot** in the **Inspector**, or tap **Center Pivot** to put it in the middle of the painted tiles. **Painted Area** shows how many columns and rows they cover.

Moving the pivot moves the tiles around the actor; it never changes which cell a tile is in. Turning **Unbounded** on keeps every tile where it is in the scene, with the pivot at 0, 0. Turning it off gives the map the size of its painted tiles; when some lie left of or below cell 0, 0, the editor asks first and then moves every tile so the painted area starts at cell 0, 0. It also asks when the pivot is not at 0, 0: the tiles keep their cells, but cell 0, 0 goes to the actor's position, so they move in the scene. You can undo either change.

## Place a tilemap

In **Place Actors**, choose **Rendering > Tilemap** and set **Asset** on its Tilemap component, or pick your Tilemap under **Content > Project**. Cell 0, 0 sits at the actor's position, and the map extends right and up; an unbounded map puts its **Pivot** there instead. Tilemaps work in scenes and in Scene Layers.

The [Tilemap](../components/tilemap.md) component's **Sorting Layer** and **Order In Layer** place the whole map among other sprites; the map's own layers sort inside it.

## Collision

Each layer with **Collision** on becomes solid ground from its Full and Chain tiles, with no Rigid Body or Collider needed. Neighbouring Full tiles merge into one outline, so characters slide along a floor without catching on tile edges. Turn **Collision** off for background and decoration layers. Use a scene whose **Physics World** is **2D (Rapier)**.

## Things to know

- **Bucket** stops at the edge of the map. On an empty layer it fills the whole map. On an unbounded map it stops 16 cells past the layer's painted tiles and the cell you tap.
- Removing a Tileset from a map erases its tiles from every layer. The editor asks first, and you can undo it.
- Animated tiles play in Play, Simulate and Preview Build, and pause when the game pauses. The editor viewport shows each animated tile's first frame.
- Parallax applies only in Play, not in the editor viewport.

## Related

- [Tileset](../assets/tileset.md)
- [Tilemap](../assets/tilemap.md)
- [Sprites](sprites.md)
- [2D](index.md)
