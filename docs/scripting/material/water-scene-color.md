---
node: input.waterSceneColor
---

# Water Scene Color

Returns the scene behind the water at this point, bent by the waves as built-in Refraction bends it.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Normal | Vector 3 |  | The surface normal that bends the view. The [**Water Waves**](water-waves.md) Normal when unconnected, else straight up. |
| Refraction | Float |  | How far the view bends. The asset's **Refraction** when unconnected. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Color | Vector 3 | Linear colour of what lies behind the water. Black where Available is 0. |
| Available | Float | 1 where Color came from the scene, 0 where it is not available. |

## Notes

- The scene behind the water is available in scene viewports and Play when the Material's **Blend Mode** is Translucent and the project's **Water Refraction** quality is on. It is not available in the material preview or in captures.
- Mix toward your own colour with Available, so the water still looks right where the scene is not available.
- Never shows anything in front of the water, such as an object standing in it.
- Only in Surface and Landscape materials.
