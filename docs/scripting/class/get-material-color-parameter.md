---
node: material.getColorParameter
---

# Get Material Color Parameter

Returns the current value of a named Color parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. In a Class whose mesh components have Materials, pick it from their parameters of this type. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Color | Red, green, blue and alpha. The Material converts red, green and blue from display colour to linear. |
| Found | Boolean |  |

## Notes

- **Found** is false, and **Value** is opaque black, when the parameter does not exist, is not a Color, or the Material Object is no longer valid.
