---
node: material.getVector3Parameter
---

# Get Material Vector3 Parameter

Returns the current value of a named Vector3 parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. In a Class whose mesh components have Materials, pick it from their parameters of this type. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Vector3 |
| Found | Boolean |

## Notes

- **Found** is false, and **Value** is 0, 0, 0, when the parameter does not exist, is not a Vector3, or the Material Object is no longer valid.
