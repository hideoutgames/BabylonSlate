---
node: input.sceneColor
---

# Scene Color

Returns the colour of the rendered scene at a position on the screen.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| UV | Vector2 | Screen position to read; the current pixel when unconnected. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| RGBA | Vector4 | Red, green, blue and alpha. |
| RGB | Vector3 | Red, green and blue only. |
| A | Float | Alpha only. |

## Notes

- Connect it to [**Post Process Output**](post-process-output.md) to keep the original image.
- Only in Post Process materials, in the fragment stage.
