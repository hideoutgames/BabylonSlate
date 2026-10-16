# Add Input Action Binding

Adds a key binding to an Input Action while the game runs.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Input Action | InputType | The Input Action asset to add the binding to. |
| Key | Key | The key, mouse button or gamepad control to bind. |
| Binding Options | InputBinding | Optional modifiers (Shift, Ctrl, Alt, Meta) for the new binding. Its other fields are ignored. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- Changes apply to the running game as player overrides and do not edit the Input asset.
- **Success** is false when the Input Action is not valid, **Key** is None, or **Binding Options** holds an invalid value.
