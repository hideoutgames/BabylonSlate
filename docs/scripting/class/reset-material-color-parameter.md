# Reset Material Color Parameter

Restores a Color parameter on a Material Object to its original value.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- The original value is the one authored in the Material, or the one saved on a post-process pass.
- **Success** is false when the parameter does not exist or the Material Object is no longer valid.
