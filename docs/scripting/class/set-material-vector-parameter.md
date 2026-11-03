---
node: material.setVectorParameter
---

# Set Material Vector Parameter

Sets a named Vector 2 or Vector 3 parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. |
| Value | Vector 3 |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- A Vector 2 parameter takes **X** and **Y**; **Z** is ignored.
- Only this Material Object changes; the Material asset and other meshes that use it keep their values.
- Nothing happens if the name is empty or unknown, or a component of the value is not a finite number.
- Get the Material Object of a mesh with its **Get Material** function. It becomes invalid when the mesh gets a different material, so get it again afterwards.
