# Tilemap

A painted 2D tile map made of layers, each drawing tiles from one or more Tilesets.

## Create

In the **Content Browser**, choose **New Asset > 2D > Tilemap**. A new Tilemap is 64 × 64 tiles and has one layer named **Ground**. Create a [Tileset](tileset.md) first, then add it to the map.

## Editor

Double-tap a Tilemap to open it.

- **Paint**: the map. Pick a tool in the toolbar and choose the layer in the **Paint Layer** picker.
- **Palette**: the tiles of the map's Tilesets. Tap a tile to paint with it; **Search Tiles** filters long lists.
- **Inspector**: **Tilesets**, **Map**, **Layers** and the selected layer.

| Tool | Effect |
| --- | --- |
| Move | Pans the map. The default tool. |
| Brush, Eraser | Paint or erase tiles under your finger. |
| Rect | Fills the rectangle you drag. |
| Bucket | Fills the connected area of matching tiles. |
| Stamp | Places a 2 × 2 block of the selected tile. |
| Picker | Picks the tile you tap as the brush. |

Each stroke is one undo step. Two fingers pinch to zoom and drag to pan in any tool.

## Settings

| Setting | Description |
| --- | --- |
| Tilesets | The Tilesets the map can use. **Add Tileset** adds one. Removing a Tileset erases its tiles from every layer; the editor asks first. |
| Map Width, Map Height | Map size in tiles. Default 64 × 64. Shrinking the map removes tiles outside it. |
| Tile Width, Tile Height | Cell size in pixels. Default 16. Usually the same as the Tileset's tile size. |
| Chunk Size | Tiles per side of each internal block. Default 32. |

**Layers** lists the layers. **Add Layer** adds one, and the eye button hides or shows a layer. Under **Selected Layer**:

| Setting | Description |
| --- | --- |
| Layer Name | The layer's name. |
| Visible | Hidden layers keep their tiles but do not draw. |
| Collision | Makes the layer's solid tiles collide. On for new layers. |
| Sorting Layer, Order In Layer | Draw order of this layer within the map. |
| Parallax | How far the layer moves with the camera in Play. 1, 1 stays fixed to the world; 0, 0 follows the camera. Default 1, 1. |

## Notes

- Layers with **Collision** on become solid ground from their Full and Chain tiles. No Rigid Body or Collider is needed. Use a Scene whose **Physics World** is **2D (Rapier)**.
- The Tilemap component's own **Sorting Layer** and **Order In Layer** place the whole map among other sprites.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tileset](tileset.md)
- [Tilemap component](../components/tilemap.md)
