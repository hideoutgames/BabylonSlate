# Texture Sample

Samples a texture at UV and returns its colour, its separate channels and the texture itself.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Texture | Texture | Connect a [**Texture Parameter**](texture-parameter.md) or another node's Texture output. Leave it unconnected to use the texture picked in the **Inspector**. |
| UV | Vector 2 | Where to sample. When unconnected, uses the mesh UV, the particle UV or [**Screen UV**](screen-uv.md), depending on the material's domain. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| RGBA | Vector 4 |  |
| RGB | Vector 3 |  |
| R | Float |  |
| G | Float |  |
| B | Float |  |
| A | Float |  |
| Texture | Texture | The texture this node samples, for passing on to other nodes such as another **Texture Sample** or [**Custom GLSL**](custom-glsl.md). |

## Settings

| Setting | Description |
| --- | --- |
| Color Space | Color (sRGB) converts the texture to linear. Data (Linear) leaves the values unchanged. |
| Texture | The texture asset to sample when the Texture pin is unconnected. |

## Notes

- Colour textures are read as sRGB and converted to linear by default. Set Color Space to Data (Linear) for normal maps and masks.
