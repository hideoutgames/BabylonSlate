# Tileset

Tile definitions and collision for painting Tilemaps: a Texture sliced into a grid of tiles.

## Create

In the **Content Browser**, choose **New Asset > 2D > Tileset**. Import your tile sheet as a Texture first. See [Importing](../editor/importing.md).

## Editor

Double-tap a Tileset to open it.

- **Preview**: the tile sheet with its grid. Choose **Move** to pan with one finger, or **Select** to drag a box around several tiles. Pinch or scroll to zoom. If no Texture is set, tap **Pick Texture**.
- The Preview toolbar also holds **Collision** (**None**, **Full**, **Chain**) for the selected tiles, and **Paint Collision**, which copies the current tile's collision onto each tile you tap or select.
- **Inspector**: the sheet's settings, its **Terrains**, then the selected tiles. Edits apply to every selected tile.

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
| Terrain | The terrain the tile belongs to, or **None**. Shown once the Tileset has a terrain. |
| Terrain Neighbours | For a terrain tile: the sides, and for **Blob (47)** also the corners, where the tile's artwork continues into the same terrain. |

**Selected Terrain**

| Setting | Description |
| --- | --- |
| Terrain Name | The name shown in the Tilemap **Palette**. |
| Style | **4 Sides (16)** or **Blob (47)**. See [Terrains](#terrains). |

## Terrains

A terrain turns a group of tiles into an autotile brush. Paint it on a Tilemap and every cell picks the tile that fits its neighbours, so edges and corners follow your strokes.

1. Under **Terrains**, tap **Add Terrain**. Set its **Terrain Name** and **Style** under **Selected Terrain**.
2. Select the terrain's tiles and set **Terrain** to the new terrain.
3. For each tile, press the **Terrain Neighbours** its artwork continues into. A grass top piece, for example, continues east, west and south, but not north.

| Style | Matches |
| --- | --- |
| 4 Sides (16) | The four side neighbours, for up to 16 different tiles. Good for strips, pipes and simple platforms. |
| Blob (47) | The sides and the corners, for up to 47 tiles. A corner counts only when both sides next to it continue, which gives inner corners. |

The line under **Selected Terrain** shows how many of the style's variants your tiles cover. A sheet does not need all of them: where a variant is missing, the brush paints the closest tile, and it prefers a tile that draws no edge inside the terrain. Ties go to the lower tile number.

Each tile belongs to at most one terrain. Removing a terrain takes its tiles out of it; you can undo it.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tilemap](tilemap.md)
- [Tilemap component](../components/tilemap.md)
- [Texture](texture.md)
