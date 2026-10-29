---
node: input.waterReflection
---

# Water Reflection

Returns what the water mirrors at this point, and how strongly it reflects.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Normal | Vector 3 |  | The surface normal to reflect around. The [**Water Waves**](water-waves.md) Normal when unconnected, else straight up. |
| Roughness | Float |  | How rough the water is close by, which blurs the reflection. The asset's **Roughness** when unconnected. Like built-in water, the water gets rougher with distance. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Color | Vector 3 | Linear colour of the reflection, times the asset's **Reflection Strength**. Dimmer where a wave would reflect a ray below the horizon, toward other water. |
| Fresnel | Float | How much the water reflects: about 0.02 looking straight down, rising toward grazing angles, less the rougher the water. The same amount built-in water uses. |
| Normal | Vector 3 | The normal that lights the water along its reflection, as built-in water's does: halfway between the view and the reflected ray. The normal it reflects around is flattened toward straight up where distant water meets the horizon through haze and fog. Connect it to **Normal** on [**Material Output**](material-output.md) so the lighting, such as the sun's highlight, matches the reflection. |
| Roughness | Float | The roughness the reflection is blurred by, as built-in water's: Roughness close by, rougher with distance and where the waves change within a pixel, and smooth again where the distant water mirrors the horizon. Connect it to **Roughness** on [**Material Output**](material-output.md) so distant sun glints break up into a soft sheen instead of flickering. |

## Notes

- Reflects the scene's environment or skybox, or a sky made from the scene's background and sun when it has neither.
- Also reflects scene objects when the asset's **Object Reflections** is on:
  - At **Planar** [Water Reflections](../../graphics/water.md) quality, a flat body (not a River or a tilted volume) mirrors them as built-in water does. Each view mirrors one body, the one that covers most of it.
  - Otherwise, at Screen Space or Planar quality, it reflects the objects it can see on screen. This needs a Translucent Material.
- Blend it over the water's colour with [**Mix**](mix.md), using Fresnel as the blend.
- Reflected rays stay just above the horizon, so the water never mirrors more water.
- Toward the horizon, distant water becomes a level mirror of the horizon sky. Fresnel rises to 1 there, so the water melts into the sky as built-in water does.
- Only in Surface and Landscape materials.
