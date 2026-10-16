---
node: input.removeActionBinding
---

# Remove Input Action Binding

Removes every binding of a key from an Input Action.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Input Action | InputType | The Input Action asset to remove the binding from. |
| Key | Key |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- Matches the key whatever its modifiers, so chords are removed too.
- Changes apply to the running game as player overrides and do not edit the Input asset.
- **Success** is false when the action has no binding for that key.
