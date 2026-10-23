---
node: input.mirrorReflection
---

# Mirror Reflection

Returns the reflection a Mirror component shows at the current point of its surface.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Offset | Vector 2 | (0, 0) | Shifts where the reflection is read, in fractions of the view's width and height. Small values distort it, for ripples or warped glass. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Color | Vector 3 | Reflected colour, as linear colour. |

## Notes

- Use it in a Material assigned as a [**Mirror**](../../components/mirror.md) component's **Material**. On any other mesh, and in the Material editor preview, it returns black.
- Before the mirror has drawn its first reflection, it returns black.
- For ripples, feed **Offset** a small value that changes across the surface, such as [**Perlin Noise**](perlin-noise.md) of [**UV**](uv.md) and [**Time**](time.md) multiplied by about 0.01, or the X and Y of a normal map scaled down the same way.
- The output skips the Mirror's **Tint**: multiply it yourself.
- Only in Surface materials, in the fragment stage.
