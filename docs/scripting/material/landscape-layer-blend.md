# Landscape Layer Blend

Mixes a Base colour toward a Layer colour by a weight.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Base | Vector 3 | (0.3, 0.3, 0.3) |  |
| Layer | Vector 3 | (0.8, 0.8, 0.8) |  |
| Weight | Float | 0 | 0 returns **Base** and 1 returns **Layer**. |

## Outputs

| Pin | Type |
| --- | --- |
| Color | Vector 3 |

## Notes

- Connect an output of [**Landscape Paint Layers**](landscape-paint-layers.md) to Weight to show a painted layer where it is painted.
- Only in Landscape materials.
