---
node: output.postProcess
---

# Post Process Output

Sets the colour of each pixel in a post-process pass.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Color | Vector 4 | (0, 0, 0, 1) |

## Notes

- Add the material as a pass under **Post Processing** in the scene's **Inspector** to run it.
- Unconnected, it writes opaque black. Connect [**Scene Color**](scene-color.md) to keep the original image.
- Only in Post Process materials.
