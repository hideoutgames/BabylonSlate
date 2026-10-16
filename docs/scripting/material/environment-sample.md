# Environment Sample

Returns the colour of the scene's environment lighting in a direction, blurred by roughness.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Direction | Vector 3 | (0, 0, 1) | World-space direction to sample; a zero vector samples along +Z. |
| Roughness | Float | 0 | 0 is a sharp view of the environment and 1 is the blurriest. Values are limited to 0 to 1. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Linear Radiance | Vector 3 | Environment colour as linear radiance, before any tone mapping. |

## Notes

- Returns black when the scene has no environment texture. The result ignores **Environment Influence** and the scene's environment intensity.
- Available in Surface, Landscape and Post Process materials, in the fragment stage only, so it cannot feed **World Position Offset**.
