# Set Material Color Parameter

Sets a named Color parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. |
| Value | Vector 4 | Red, green, blue and alpha in X, Y, Z and W. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Only this Material Object changes; the Material asset and other meshes that use it keep their values.
- Nothing happens if the name is unknown or a channel is not a finite number.
- A Material Object becomes invalid when its mesh gets a different material, so get it again afterwards.
