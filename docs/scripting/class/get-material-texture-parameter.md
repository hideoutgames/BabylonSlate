# Get Material Texture Parameter

Returns the Texture assigned to a named Texture parameter on a Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Texture Asset |
| Found | Boolean |

## Notes

- **Found** is false, and **Value** is empty, when the parameter does not exist, is not a Texture, or the Material Object is no longer valid.
