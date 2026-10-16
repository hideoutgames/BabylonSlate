---
node: texture.sampleLod
---

# Texture Sample LOD

Samples a texture at a chosen mip level instead of the level the GPU would pick.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Texture | Texture |  | Connect a [**Texture Parameter**](texture-parameter.md) or another node's Texture output. Leave it unconnected to use the texture picked in the **Inspector**. |
| UV | Vector 2 |  | Where to sample. When unconnected, uses the mesh UV, the particle UV or [**Screen UV**](screen-uv.md), depending on the material's domain. |
| LOD | Float | 0 | Mip level to sample; 0 is the full-resolution image. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| RGBA | Vector 4 |  |
| RGB | Vector 3 |  |
| A | Float |  |
| Texture | Texture | The texture this node samples, for passing on to other nodes. |

## Settings

| Setting | Description |
| --- | --- |
| Color Space | Color (sRGB) converts the texture to linear. Data (Linear) leaves the values unchanged. |
| Texture | The texture asset to sample when the Texture pin is unconnected. |

## Notes

- Fragment stage only, so it cannot feed **World Position Offset**.
- Needs texture LOD support on the device.
- Colour textures are read as sRGB and converted to linear by default. Set Color Space to Data (Linear) for masks.
