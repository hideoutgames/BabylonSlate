# Tileset

Tile definitions and collision for painting Tilemaps: a Texture sliced into a grid of tiles.

## Create

Import your tile sheet as a Texture first. See [Importing](../editor/importing.md). Then, in the **Content Browser**:

- Right-click or long-press the Texture and choose **Create Tileset**. The Tileset takes the Texture's name and size, sits beside it and opens; set **Tile Width** and **Tile Height** next.
- Or choose **New Asset > 2D > Tileset** and pick the Texture in the editor.

## Editor

Double-tap a Tileset to open it.

- **Preview**: the tile sheet with its grid. Choose **Move** to pan with one finger, **Select** to drag a box around several tiles, or **Autotile** to mark the selected autotile's tiles (see [Autotiles](#autotiles)). Pinch or scroll to zoom. If no Texture is set, tap **Pick Texture**.
- The Preview toolbar also holds **Collision** (**None**, **Full**, **Chain**) for the selected tiles, and **Paint Collision**, which copies the current tile's collision onto each tile you tap or select.
- **Inspector**: the sheet's settings, its **Autotiles**, then the selected tiles. Edits apply to every selected tile.

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

**Autotile** (the one selected under **Autotiles**)

| Setting | Description |
| --- | --- |
| Name | The name shown in the Tilemap **Palette**. |
| Layout | **4 Sides (16)** or **Blob (47)**. See [Autotiles](#autotiles). |

## Autotiles

An autotile turns a group of tiles into a brush that picks pieces for you. Paint it on a Tilemap and every cell takes the tile that fits its neighbours, so edges and corners follow your strokes.

1. Under **Autotiles** in the **Inspector**, tap **New Autotile** and set its **Name** and **Layout**. The **Preview** switches to the **Autotile** tool.
2. Mark the autotile's tiles in one of two ways:
   - **Fill From Layout…**: if your sheet follows the standard layout for the autotile's **Layout**, tap the tile where that block starts and choose **Fill**. Every tile in the block gets its neighbours in one step. The dialog shows the layout next to your sheet.
   - **Autotile** tool: each tile in the **Preview** shows a 3 × 3 grid. The middle says the tile belongs to the autotile; the sides and corners say its artwork continues that way. Tap a square to turn it on or off, or drag across tiles to mark many at once. A grass top piece, for example, continues east, west and south, but not north.
3. Check **Coverage**: it counts the variants that have a tile and shows the missing ones.

| Layout | Matches | Standard block |
| --- | --- | --- |
| 4 Sides (16) | The four side neighbours, for up to 16 different tiles. Good for strips, pipes and simple platforms. | 4 × 4: a 3 × 3 island, a vertical strip on the right, a horizontal strip along the bottom and a single tile in the bottom-right corner. |
| Blob (47) | The sides and the corners, for up to 47 tiles. A corner counts only when both sides next to it continue, which gives inner corners. | 12 × 4: the 4 Sides island with solid corners in the first four columns, then the 31 inner-corner pieces, one cell left empty. |

With the **Autotile** tool, turning a corner on also turns its two sides on, and turning a side off turns its corners off. **4 Sides** autotiles have no corners: a tap in a corner goes to the nearer side. A drag that starts on a square that is off turns squares on, and one that starts on a square that is on turns them off. Each drag is one undo step.

A sheet does not need every variant: where one is missing, the brush paints the closest tile, and it prefers a tile that draws no edge inside the autotile. Ties go to the lower tile number.

Each tile belongs to at most one autotile; marking a tile for another autotile moves it over. Removing an autotile takes its tiles out of it; you can undo it. After changing an autotile, use **Refresh Autotiles** in the Tilemap to update maps already painted with it.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tilemap](tilemap.md)
- [Tilemap component](../components/tilemap.md)
- [Texture](texture.md)
