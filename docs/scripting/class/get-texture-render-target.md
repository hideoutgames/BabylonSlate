---
node: render-target.getTextureTarget
---

# Get Texture Render Target

Returns the Render Target that a Render Target Texture displays.

## Inputs

| Pin | Type |
| --- | --- |
| Texture | RenderTargetTexture Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Render Target | RenderTarget Asset |

## Notes

- The texture loads with the object that runs this node, so the answer is ready at once.
- Returns none when the texture has no Render Target assigned.
