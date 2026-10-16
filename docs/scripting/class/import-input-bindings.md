# Import Input Bindings

Applies binding changes exported earlier, replacing the current changes.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data | String | Text returned by [**Export Input Bindings**](export-input-bindings.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- Nothing changes and **Success** is false when the text is not valid output from [**Export Input Bindings**](export-input-bindings.md).
