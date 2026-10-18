# Tileset

Tile definitions and collision for painting Tilemaps: a Texture sliced into a grid of tiles.

## Create

In the **Content Browser**, choose **New Asset > 2D > Tileset**. Import your tile sheet as a Texture first. See [Importing](../editor/importing.md).

## Editor

Double-tap a Tileset to open it.

- **Preview**: the tile sheet with its grid. Choose **Move** to pan with one finger, or **Select** to drag a box around several tiles. Pinch or scroll to zoom. If no Texture is set, tap **Pick Texture**.
- The Preview toolbar also holds **Collision** (**None**, **Full**, **Chain**) for the selected tiles, and **Paint Collision**, which copies the current tile's collision onto each tile you tap or select.
- **Inspector**: the sheet's settings, then the selected tiles. Edits apply to every selected tile.

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
| Frame Duration MS | Length of each animation frame. Default 100. |

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tilemap](tilemap.md)
- [Tilemap component](../components/tilemap.md)
- [Texture](texture.md)
