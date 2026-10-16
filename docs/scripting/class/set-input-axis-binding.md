# Set Input Axis Binding

Changes the key of an existing Input Axis binding.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Input Binding | InputBinding | The binding to change, as returned by [**Get Input Bindings**](get-input-bindings.md). |
| Key | Key | The new key, mouse button or gamepad control. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- The binding keeps its modifiers, X or Y component, direction and tuning; only the key changes.
- Changes apply to the running game as player overrides and do not edit the Input asset.
- **Success** is false when the binding no longer exists or **Key** is None.
