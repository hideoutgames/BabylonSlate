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

You build autotiles in the **Autotiles** window: a tab beside the **Preview**, also opened by **Edit Autotiles** in the **Inspector**. On a phone, pick **Autotiles** in the window picker. The window has three columns: the list of autotiles, the pieces of the one you selected with a small preview map, and the sheet. On a narrow screen they stack.

### Create an autotile

Tap **+** beside **Autotiles**. A new autotile named **Autotile** appears in the list, selected, with its name ready to type over. It starts as **Blob**; choose its **Layout** above its pieces:

| Layout | Pieces | Good for |
| --- | --- | --- |
| 4 Sides | 16. A piece follows its four side neighbours. | Strips, pipes and simple platforms. |
| Blob | 47. A piece also follows its corners, where both sides next to the corner continue, which gives inner corners. | Ground and walls with inner corners. |

Changing the Layout keeps every tile where it is. When the autotile already has tiles, the editor first tells you how many pieces will have a tile, how many will be missing, and which tiles become unused because another tile already draws their piece.

Each row shows the autotile's fill tile, its name and a dot: green when every piece it needs has a tile (every 4 Sides piece, or Blob's **Main** and **Inner Corners**), amber otherwise. The **⋯** menu of a row holds **Rename**, **Add Next To** (see [Transitions](#transitions)) and **Delete**. Deleting an autotile takes its tiles out of it, and other autotiles' pieces next to it go too; you can undo it. Tilemaps keep the tiles already painted with it.

### Assign pieces

Select a row to edit its pieces. The pieces are grouped:

- **4 Sides**: **Pieces**, the 16 pieces in the order of the standard 4 × 4 sheet block.
- **Blob**: **Main** (the island with solid corners, 16 pieces), **Inner Corners** (four corners around a one-tile hole) and **More Corners** (the other 27 combinations, folded away). **More Corners** is optional: where a piece is missing, the brush paints the closest one.

Each group says how many of its pieces have a tile. A piece shows its tile, or, while it has none, its shape: the middle square is the tile, the shaded parts are the neighbours it continues into, and the lines are the edges it draws.

- Tap a piece, then tap its tile on the sheet. The next empty piece is selected for you, so you can tap one tile after another. With a mouse you can also drag a tile from the sheet onto any piece.
- The line above the pieces names the selected piece, its tile (or the tile painting uses instead while it has none) and how many cells of the preview use it.
- Each piece has one tile. Giving a piece another tile takes the old one out, and a tile of another autotile moves over.
- On the sheet, the tiles you are editing carry a dot and the selected piece's tile is outlined. Tiles of other autotiles are dimmed.
- To clear a piece, tap the **×** in its corner (it shows on the selected piece, and on any piece under the mouse), tap **Clear** on the line above the pieces, or press Delete. Arrow keys move between pieces.

If your sheet draws a whole group in the usual arrangement, tap the group's block button and then tap the top-left tile of that block on the sheet: every piece of the group is assigned at once. With a mouse, the block is outlined on the sheet before you click. Press Esc, or tap the button again, to stop. On a sheet in the standard 12 × 4 Blob layout, assign **Main** from its first column and **More Corners** from its fifth: that is all 47 pieces, inner corners included.

Each change is one undo step.

### Preview

**Preview** is a small map painted exactly as a Tilemap brush paints it, starting with shapes that use most of the pieces. Tap a cell to paint it or erase it; the cells around it update. **Reset** brings back the starting shapes. The map is never saved.

- The cells that use the selected piece are highlighted, even while the piece has no tile, so you can see where it goes.
- A cell with an amber dot has no tile for its piece and uses the closest one instead. The line beside **Preview** says how many cells do.
- With a mouse, hover a cell to outline its piece among the pieces. Long-press or right-click a cell and choose **Select Piece** to select the piece it uses.

A sheet does not need every piece: where one is missing, the brush paints the closest tile, and it prefers a tile that draws no edge inside the autotile. Ties go to the lower tile number.

Maps painted with an autotile follow your changes to it by themselves. Every Tilemap that uses this Tileset picks its autotile cells again, in the Tilemap editor, the viewport, Play and exported games. Pieces placed by hand on a Tilemap stay until you change one of this Tileset's autotiles.

## Transitions

A transition joins two autotiles of the same Tileset, such as grass meeting dirt. Without one, an autotile treats a different autotile next to it as empty and draws its edge there. With one, the autotile has a second set of pieces drawn next to the other autotile: their open sides show the other autotile instead of nothing.

To add one, open the **⋯** menu of an autotile and choose the other autotile under **Add Next To**. The set appears under the autotile as **Next to** followed by the other autotile's name; select it to assign its pieces as you would the ordinary ones. Its preview shows the autotile inside a field of the other one, and a tap switches a cell between the two. The **×** on the set's row removes it with its tiles; you can undo it.

- When each autotile has pieces drawn next to the other, each draws its own half of the seam.
- When only one of them has pieces drawn next to the other, that one draws the whole seam, and the other continues under it as if the seam were more of itself.
- A cell next to several other autotiles uses the transition it faces on the most sides. When every side continues, a **Blob** autotile looks at its corners instead. A tie uses the ordinary pieces.
- A transition with a piece missing paints its closest piece, and one with no pieces paints the ordinary ones.
- Autotiles of different Tilesets never use transitions; they count as empty to each other.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tilemap](tilemap.md)
- [Tilemap component](../components/tilemap.md)
- [Texture](texture.md)
