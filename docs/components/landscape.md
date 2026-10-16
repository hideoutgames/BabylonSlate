# Landscape

A sculptable terrain: a grid of height points you raise, lower, smooth, flatten and paint in the viewport.

## Create it

A Landscape is created in Landscape mode, not through **Add Component** or **Place Actors**.

1. Open a world scene and set **Scene Mode** to **Landscape**.
2. In **Landscape Outliner**, choose **Create Landscape**. A new Landscape is 64 by 64 units with 64 cells.
3. Pick a tool in the viewport toolbar and drag across the terrain.

## Tools and brush

| Tool | Effect |
| --- | --- |
| Raise, Lower | Moves points up or down. |
| Smooth | Averages points with their neighbours. |
| Flatten | Moves points toward **Flatten Height**. |
| Paint Layer | Paints **Paint Layer** 1 to 4 for the Landscape Material to use. |

**Landscape Settings > Brush** sets **Radius** (default 4), **Strength** (0.25) and **Falloff** (0.5). **Flatten Height** shows for Flatten and **Paint Layer** for Paint Layer.

## Settings

Select a Landscape in **Landscape Outliner**, then use **Landscape Settings**.

| Setting | Description |
| --- | --- |
| Name | The actor's name. |
| Size | Width and depth in units, 1 to 4096. |
| Cells | Cells along each side, 4 to 256. Changing it resamples the height and paint data. |
| Landscape Collisions | Makes the terrain solid in Play. Off by default. 3D physics only. |
| Landscape Material | A Material with the Landscape domain. Empty uses the default. |

## Notes

- World scenes only.
- Locked actors cannot be sculpted or edited.
- A Landscape Material reads the four paint weights with the [Landscape Paint Layers](../scripting/material/landscape-paint-layers.md) node.

## Related

- [Landscape and Foliage](../scenes/landscape.md)
- [Foliage](foliage.md)
- [Materials](../graphics/materials.md)
