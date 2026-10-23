---
node: input.waterReflection
---

# Water Reflection

Returns what the water mirrors at this point, and how strongly it reflects.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Normal | Vector 3 |  | The surface normal to reflect around. The [**Water Waves**](water-waves.md) Normal when unconnected, else straight up. |
| Roughness | Float |  | Blurs the reflected sky. The asset's **Roughness** when unconnected. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Color | Vector 3 | Linear colour of the reflection, times the asset's **Reflection Strength**. |
| Fresnel | Float | How much the water reflects: about 0.02 looking straight down, rising to 1 at grazing angles. |

## Notes

- Reflects the scene's environment or skybox, or a sky made from the scene's background and sun when it has neither.
- Also reflects scene objects when the asset's **Object Reflections** is on, the Material is Translucent and the project's **Water Reflections** quality is Screen Space or Planar.
- Blend it over the water's colour with [**Mix**](mix.md), using Fresnel as the blend.
- Only in Surface and Landscape materials.
