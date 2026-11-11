---
node: material.setVector4Parameter
---

# Set Material Vector4 Parameter

Sets a named Vector4 parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. In a Class whose mesh components have Materials, pick it from their parameters of this type. |
| Value | Vector4 |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Only this Material Object changes; the Material asset and other meshes that use it keep their values.
- Nothing happens if the name is empty or unknown, the parameter is not a Vector4, or a component of the value is not a finite number.
- The four components are passed to the shader as they are. A Color parameter converts its red, green and blue from display colour to linear; a Vector4 does not.
- Get the Material Object of a mesh with its **Get Material** function. It becomes invalid when the mesh gets a different material, so get it again afterwards.
