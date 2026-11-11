---
node: texture.triplanar
---

# Triplanar

Samples a texture along the three world axes and blends the results by the surface normal, so a mesh needs no UVs and shows no stretching.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Texture | Texture |  | Connect a [**Texture Parameter**](texture-parameter.md) or another node's Texture output. Required. |
| Scale | Float | 1 | How many times the texture repeats per metre. |
| Sharpness | Float | 1 | How quickly one projection gives way to the next. Higher values make the seams narrower. |

## Outputs

| Pin | Type |
| --- | --- |
| RGBA | Vector4 |
| RGB | Vector3 |
| A | Float |

## Settings

| Setting | Description |
| --- | --- |
| Color Space | Color (sRGB) converts the texture to linear. Data (Linear) leaves the values unchanged. |

## Notes

- The texture is placed by world position, so it stays put when the mesh moves and lines up across neighbouring meshes.
- Costs three texture samples.
- Only in Surface and Landscape materials, in the fragment stage.
