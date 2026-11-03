---
node: material.getFloatParameter
---

# Get Material Float Parameter

Returns the current value of a named Float parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. In a Class whose mesh components have Materials, pick it from their parameters of this type. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |
| Found | Boolean |

## Notes

- **Found** is false, and **Value** is 0, when the parameter does not exist, is not a Float, or the Material Object is no longer valid.
