# Tilemap

A painted 2D tile map made of layers, each drawing tiles from one or more Tilesets.

## Create

In the **Content Browser**, choose **New Asset > 2D > Tilemap**. A new Tilemap is 64 × 64 tiles and has one layer named **Ground**. Create a [Tileset](tileset.md) first, then add it to the map.

Or select one or more Tilesets, right-click one and choose **Create Tilemap**: the new Tilemap already has them in its Palette and uses the first one's tile size. See [Create from assets](../editor/content-browser.md#create-from-assets).

## Editor

Double-tap a Tilemap to open it.

- **Paint**: the map. Pick a tool in the toolbar and choose the layer in the **Paint Layer** picker, the same layer the **Inspector** shows under **Selected Layer**. A hidden layer shows **Layer Hidden** in the toolbar. With a mouse, the toolbar shows the cell under the pointer; with **Select**, the top-left corner of **Paint** shows it.
- **Palette**: the autotiles of the map's Tilesets, then their tiles. Tap a tile to paint with it, or an autotile to paint with that autotile; **Search Tiles** filters long lists.
- **Inspector**: **Tilesets**, **Map**, **Layers** and the selected layer.

| Tool | Key | Effect |
| --- | --- | --- |
| Move | <kbd>M</kbd> | Pans the map. The default tool. |
| Select | <kbd>S</kbd> | Selects placed tiles to move, cut, copy, paste or delete them. See [Select and move tiles](#select-and-move-tiles). |
| Brush, Eraser | <kbd>B</kbd>, <kbd>E</kbd> | Paint or erase tiles under your finger. |
| Rect | <kbd>R</kbd> | Fills the rectangle you drag. An outline shows it until you lift your finger. |
| Bucket | <kbd>G</kbd> | Fills the connected area of matching tiles, up to the edge of the map. On an unbounded map, up to 16 cells past the layer's painted tiles. |
| Stamp | <kbd>T</kbd> | Places a 2 × 2 block of the selected tile. |
| Picker | <kbd>I</kbd> | Picks the tile you tap as the brush. |

With a keyboard, a tool's key picks it while **Paint** has keyboard focus: tap or click the map first. The keys do nothing while you type in a field. Each tool's tooltip shows its key; change them in **Engine Settings > Keybinds** under **Tilemap Paint** ([Keyboard shortcuts](../start/shortcuts.md#tilemap-paint)).

With an autotile selected, every tool paints the autotile and the cells around your stroke update to match. The **Eraser** always updates the autotile tiles around the cells it clears. When a Tileset's autotiles change, the map's autotile cells update by themselves; the open Tilemap shows the update at once and saves it with your next edit. See [Paint with autotiles](../2d/tilemaps.md#paint-with-autotiles).

Each stroke is one undo step. Two fingers pinch to zoom and drag to pan in any tool. Edits show in the Scene viewport as you make them.

## Select and move tiles

Pick **Select** in the **Paint** toolbar to work with tiles you have already placed.

- **Select**: drag across cells to select a rectangle, or tap one cell. A dashed orange outline marks the selection, and the top-left corner of **Paint** shows its size. Tap outside it, or press <kbd>Esc</kbd>, to clear it.
- **All Layers**: when on, the selection covers every visible layer, so a group of tiles moves together and each layer keeps its own tiles. Hidden layers are left out: their tiles are not selected, moved, cut, copied or deleted, a paste writes nothing into them, and they stay where they are. When off, only the paint layer, even when it is hidden.
- **Select All**: selects the area of every painted tile on the paint layer, or on every visible layer with **All Layers** on.
- **Move**: drag from inside the selection. The tiles lift off the map and follow your finger cell by cell, and their old cells show empty until you let go. Each drag is one undo step.
- **Nudge**: the arrow keys move the selection one cell, <kbd>Shift</kbd> and an arrow key eight cells. Holding a key down is one undo step.
- **Cut**, **Copy**, **Paste**, **Delete**: buttons in the toolbar (with touch, in its **Selection Actions** menu), or long-press or right-click the map for a menu with these, **Select All** and **Deselect**. A long-press or right-click outside the selection selects that cell first.

Moved and pasted tiles replace the tiles where they land. Empty cells inside the selection never erase anything.

**Paste** puts the copied tiles in the middle of the view, or where you opened the menu, floating over the map. Drag them into place, then tap, press <kbd>Enter</kbd> or choose **Place** to write them; <kbd>Esc</kbd> or **Cancel Paste** drops them. Picking another tool places them first. A paste you have not placed is dropped when **Paint** closes, for example when you close the Tilemap; the copied tiles stay available to paste again. A copy of one layer pastes into the paint layer; a copy made with **All Layers** pastes into the same layers, except those that are hidden. Copied tiles stay available while the editor is open, so you can paste them into another Tilemap too; tiles of a Tileset that map does not use are left out.

Autotile tiles around the cells you move, cut, paste or delete update as they do when you paint, so edges stay correct. A moved tile whose neighbours all moved with it keeps its piece, including one you placed by hand.

On a map with a size, tiles moved or pasted past its edge are cut off: while you drag, those cells show tinted red and the corner of **Paint** says how many tiles will be cut off, counting only the layers they land on (not hidden ones with **All Layers**). An unbounded map has no edge.

### Make room after a resize

To grow a map in one direction and move what you painted:

1. Set **Map Width** and **Map Height** in the **Inspector**. The map grows to the right and up from cell 0, 0.
2. Pick **Select**, turn on **All Layers** and tap **Select All**. Show any hidden layer first, or its tiles stay where they are.
3. Drag the selection, or nudge it with the arrow keys (<kbd>Shift</kbd> moves eight cells), to where you want it.

| Shortcut | Effect |
| --- | --- |
| <kbd>Mod</kbd>+<kbd>A</kbd> | Select All; from another tool, switches to **Select** |
| <kbd>Mod</kbd>+<kbd>X</kbd>, <kbd>Mod</kbd>+<kbd>C</kbd> | Cut, Copy |
| <kbd>Mod</kbd>+<kbd>V</kbd> | Paste; from another tool, switches to **Select** |
| <kbd>Delete</kbd> or <kbd>Backspace</kbd> | Delete |
| Arrow keys | Nudge one cell; with <kbd>Shift</kbd>, eight |
| <kbd>Enter</kbd> | Place a paste |
| <kbd>Esc</kbd> | Cancel a paste, or clear the selection |

The shortcuts work while **Paint** has keyboard focus: tap or click the map first. See [Keyboard shortcuts](../start/shortcuts.md).

## Settings

| Setting | Description |
| --- | --- |
| Tilesets | The Tilesets the map can use. **Add Tileset** adds one. Removing a Tileset erases its tiles from every layer; the editor asks first. |
| Unbounded | Removes the map's size, so you can paint in every direction. Default off. See [Unbounded maps](#unbounded-maps). |
| Map Width, Map Height | Map size in tiles. Default 64 × 64. Shrinking the map removes tiles outside it. Bounded maps only. |
| Pivot | The point of the map, in tiles, that sits at the actor's position. Moves in half-tile steps. Default 0, 0. Unbounded maps only. **Center Pivot** moves it to the middle of the painted tiles. |
| Painted Area | How many columns and rows the painted tiles cover. Unbounded maps only. |
| Tile Width, Tile Height | Cell size in pixels. Default 16. Usually the same as the Tileset's tile size. |
| Chunk Size | Tiles per side of each internal block. Default 32. Changing it keeps every tile in its cell. |

**Layers** lists the layers. **Add Layer** adds one, and the eye button hides or shows a layer. Under **Selected Layer**:

| Setting | Description |
| --- | --- |
| Layer Name | The layer's name. |
| Visible | Hidden layers keep their tiles but do not draw. |
| Collision | Makes the layer's solid tiles collide. On for new layers. |
| Sorting Layer, Order In Layer | Draw order of this layer within the map. |
| Parallax | How far the layer moves with the camera in Play. 1, 1 stays fixed to the world; 0, 0 follows the camera. Default 1, 1. |

## Unbounded maps

A bounded map has a size: cell 0, 0 is its bottom-left corner, it sits at the actor's position, and the map extends right and up. Turn on **Unbounded** for a map with no size. You paint in every direction, including left of and below cell 0, 0, and the map is as large as its painted tiles: the selection outline, framing the actor in the viewport and collision follow the furthest tiles.

- The **Pivot** is the point of the map that sits at the actor's position. **Paint** opens with the pivot in the middle of the view and shows it as a crosshair over the tiles. Drag the crosshair to move the pivot; each drag is one undo step. A tap on it still paints. With **Select**, a drag on the crosshair selects tiles instead.
- Moving the pivot moves the tiles around the actor; it never changes which cell a tile is in.
- Turning **Unbounded** on keeps every tile in place, and the pivot starts at 0, 0, so nothing moves in the scene.
- Turning it off sets the map size to the painted tiles. When some tiles lie left of or below cell 0, 0, the editor asks first, then moves every tile so the painted area starts at cell 0, 0. When the pivot is not at 0, 0, it also asks: the tiles keep their cells, but cell 0, 0 moves to the actor's position, so the tiles move in the scene. You can undo either change.
- Autotiles at the edge of an unbounded map draw their edge: beyond the painted tiles there are only empty cells.

## Notes

- Layers with **Collision** on become solid ground from their Full and Chain tiles. No Rigid Body or Collider is needed. Use a Scene whose **Physics World** is **2D (Rapier)**.
- The Tilemap component's own **Sorting Layer** and **Order In Layer** place the whole map among other sprites.
- In the Content Browser, a Tilemap's thumbnail shows the tiles its visible layers paint. Saving the map, or a Tileset or Texture it uses, draws it again.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tileset](tileset.md)
- [Tilemap component](../components/tilemap.md)
