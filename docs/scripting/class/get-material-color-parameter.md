# Get Material Color Parameter

Returns the current value of a named Color parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Vector 4 | Red, green, blue and alpha in X, Y, Z and W. |
| Found | Boolean |  |

## Notes

- **Found** is false, and **Value** is opaque black, when the parameter does not exist, is not a Color, or the Material Object is no longer valid.
