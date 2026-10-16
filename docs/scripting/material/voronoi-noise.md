---
node: noise.voronoi
---

# Voronoi Noise

Returns a cell pattern: the distance to the nearest cell point and a random value for each cell.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| UV | Vector 2 |  | Position to sample; the mesh or screen UV when unconnected. |
| Offset | Float | 0 | Moves the cell points. Animate it with [**Time**](time.md) for moving cells. |
| Density | Float | 5 | Number of cells per UV unit. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float | Grows with distance from the nearest cell point, so it is 0 at a point and highest at the cell edges. |
| Cells | Float | A random value from 0 to 1 that is the same everywhere inside one cell. |
