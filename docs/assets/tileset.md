# Tileset

Tile definitions and collision for painting Tilemaps: a Texture sliced into a grid of tiles.

## Create

Import your tile sheet as a Texture first. See [Importing](../editor/importing.md). Then, in the **Content Browser**:

- Right-click or long-press the Texture and choose **Create Tileset**. The Tileset takes the Texture's name and size, sits beside it and opens; set **Tile Width** and **Tile Height** next.
- Or choose **New Asset > 2D > Tileset** and pick the Texture in the editor.

## Editor

Double-tap a Tileset to open it.

- **Preview**: the tile sheet with its grid. Choose **Move** to pan with one finger, or **Select** to drag a box around several tiles. Pinch or scroll to zoom. If no Texture is set, tap **Pick Texture**.
- The Preview toolbar also holds **Collision** (**None**, **Full**, **Chain**) for the selected tiles, and **Paint Collision**, which copies the current tile's collision onto each tile you tap or select.
- **Autotiles**: a tab beside the Preview where you build autotiles. See [Autotiles](#autotiles).
- **Inspector**: the sheet's settings, how many **Autotiles** it has with **Edit Autotiles**, then the selected tiles. Edits apply to every selected tile.

Tiles are numbered from 1, starting at the top-left of the image.

A Tileset with no Texture still paints and plays: each tile draws as a flat coloured square, the same colour in the Paint panel, the editor viewport and Play.

## Settings

**Atlas** and **Grid**

| Setting | Description |
| --- | --- |
| Texture | The tile sheet. |
| Atlas Width, Atlas Height | Read-only. Filled in from the Texture. |
| Tile Width, Tile Height | Size of one tile in pixels. Default 16. Choose **Confirm Tile Size** to rebuild the grid. |
| Margin | Border around the sheet, in pixels. |
| Spacing | Gap between tiles, in pixels. |

**Selected Tile**

| Setting | Description |
| --- | --- |
| Tile Collision | **None**, **Full** (the whole cell is solid) or **Chain** (a solid line through **Chain Points**). |
| Chain Points | For Chain collision: points written as `x,y x,y …` in tile units, from 0,0 at the tile's bottom-left to 1,1 at its top-right. |
| Tile Flags | Eight on/off flags stored with the tile. |
| Animation Frames | Tile numbers to cycle through, separated by commas. Leave empty for a still tile. |
| Frame Duration | Length of each animation frame. Default 100. |

## Autotiles

An autotile turns a group of tiles into a brush that picks pieces for you. Paint it on a Tilemap and every cell takes the piece that fits its neighbours, so edges and corners follow your strokes.

You build autotiles in the **Autotiles** window: a tab beside the **Preview**, also opened by **Edit Autotiles** in the **Inspector**. On a phone, pick **Autotiles** in the window picker. The window has its own copy of the sheet, a board of the autotile's pieces and a small test map.

### Create an autotile

Tap **New Autotile**, enter a **Name** and choose a **Layout**, then tap **Create**. The new autotile opens in the window, with its first piece selected. Switch between autotiles with the list at the top of the window.

| Layout | Pieces | Good for |
| --- | --- | --- |
| 4 Sides | 16. A piece follows its four side neighbours. | Strips, pipes and simple platforms. |
| Blob | 47. A piece also follows its corners, where both sides next to the corner continue, which gives inner corners. | Ground and walls with inner corners. |

The **⋯** menu holds **Rename…**, **Change Layout** and **Delete Autotile**. Changing the Layout keeps every tile where it is; the editor first tells you how many pieces will have a tile, how many will be missing, and which tiles become unused because another tile already draws their piece. Deleting an autotile takes its tiles out of it, and you can undo it. Tilemaps keep the tiles already painted with it.

### Assign pieces

The **Pieces** board shows every piece of the autotile, in the order of the standard sheet block (4 × 4 for 4 Sides, 12 × 4 for Blob), with how many have a tile. A piece shows its tile, with a small grid in the corner: the middle is the tile, and the filled squares around it are the neighbours its artwork continues into. An empty piece has a dashed outline and shows, faded, the tile painting uses instead.

- **Piece, then tile**: tap a piece, then tap its tile on the sheet. The next empty piece is selected for you, so you can tap one tile after another.
- **Tile, then piece**: with no piece selected, tap a tile on the sheet, then tap the piece it draws.
- Each piece has one tile. Giving a piece another tile takes the old one out of the autotile, and a tile of another autotile moves over.
- On the sheet, this autotile's tiles carry their piece's grid and the selected piece's tile is outlined. Tiles of other autotiles are dimmed.
- To clear a piece, long-press or right-click it and choose **Clear Piece**, or select it and press Delete. **Show On Sheet** scrolls the sheet to its tile. Long-press or right-click a tile on the sheet and choose **Remove From Autotile** to take it out.
- Arrow keys move between pieces.

Each change is one undo step.

### Fill from a template

If your sheet draws pieces in a familiar arrangement, **Fill From Template…** assigns many pieces at once. It is the main button while the board is empty.

| Template | Layout | Pieces |
| --- | --- | --- |
| 4 Sides Block (4 × 4) | 4 Sides | All 16: a 3 × 3 island, a vertical strip on the right, a horizontal strip along the bottom and a single tile in the bottom-right corner. |
| Blob Block (12 × 4) | Blob | All 47: the island with solid corners in the first four columns, then the 31 inner-corner pieces, one cell left empty. |
| Island (3 × 3) | Both | Outer corners, edges and the fill. For Blob the corners are solid. |
| Horizontal Strip (3 × 1) | Both | Left end, middle and right end. |
| Vertical Strip (1 × 3) | Both | Top end, middle and bottom end. |
| Single (1 × 1) | Both | A tile with no neighbours. |
| Inner Corners, Hole (2 × 2) | Blob | Four inner corners that meet in the middle, around a one-tile hole. |
| Inner Corners, Outward (2 × 2) | Blob | Four inner corners, each pointing at the corner of the block it sits in. |

After you pick a template, its grids are drawn over the sheet. Tap where its top-left tile is, or drag it into place; it stays inside the sheet. The bar above the sheet shows what **Assign** does, for example **Assign 9 Pieces**, and how many existing assignments it replaces. Tap **Cancel** to leave the sheet as it was. Templates larger than the sheet are unavailable.

### Test paint

**Test Paint** is a small map painted with the autotile exactly as a Tilemap brush paints it. It starts with an island (with a one-tile hole for Blob), strips and a single tile.

- **Paint** and **Erase** add and remove cells; the cells around them update.
- **Pick** selects the piece a cell wants on the board.
- A cell with a warning outline has no tile for its piece and uses the closest one instead.
- **Reset** brings back the starting shapes. The map is never saved.

A sheet does not need every piece: where one is missing, the brush paints the closest tile, and it prefers a tile that draws no edge inside the autotile. Ties go to the lower tile number. After changing an autotile, use **Refresh Autotiles** in the Tilemap to update maps already painted with it.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tilemap](tilemap.md)
- [Tilemap component](../components/tilemap.md)
- [Texture](texture.md)
