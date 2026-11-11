---
node: material.setVector2Parameter
---

# Set Material Vector2 Parameter

Sets a named Vector2 parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. In a Class whose mesh components have Materials, pick it from their parameters of this type. |
| Value | Vector2 |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Only this Material Object changes; the Material asset and other meshes that use it keep their values.
- Nothing happens if the name is empty or unknown, the parameter is not a Vector2, or a component of the value is not a finite number.
- Get the Material Object of a mesh with its **Get Material** function. It becomes invalid when the mesh gets a different material, so get it again afterwards.
