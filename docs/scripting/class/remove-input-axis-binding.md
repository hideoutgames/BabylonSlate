# Remove Input Axis Binding

Removes every binding of a key from an Input Axis.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Input Axis | InputType | The Input Axis asset to remove the binding from. |
| Key | Key |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- Matches the key whatever its modifiers or X and Y component.
- Changes apply to the running game as player overrides and do not edit the Input asset.
- **Success** is false when the axis has no binding for that key.
