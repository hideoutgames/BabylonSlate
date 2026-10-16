---
node: material.setTextureParameter
---

# Set Material Texture Parameter

Sets a named Texture parameter on a Material Object, loading the Texture first.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. |
| Value | Texture Asset |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Waits until the Texture is ready before applying it. An empty **Value** clears the parameter.
- Only this Material Object changes; the Material asset and other meshes that use it keep their values.
- Latent: the node finishes later without pausing the rest of the game.
