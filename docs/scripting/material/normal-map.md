---
node: shading.normalMap
---

# Normal Map

Turns a normal map colour into a world-space normal that follows the surface's shape.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Packed | Vector 3 |  | The raw colour of a normal map texture, such as the RGB output of [**Texture Sample**](texture-sample.md) set to Data (Linear). |
| UV | Vector 2 |  | The UV used to sample the normal map; the mesh UV when unconnected. |
| Strength | Float | 1 | Scales how strongly the map bends the normal; 1 is the default. |

## Outputs

| Pin | Type |
| --- | --- |
| Normal | Vector 3 |

## Notes

- Connect the result to **Normal** on [**Material Output**](material-output.md).
- Fragment stage only, so it cannot feed **World Position Offset**.
- Only in Surface and Landscape materials.
