---
node: input.resetInput
---

# Reset Input Bindings

Restores one Input Action or Input Axis to its authored bindings.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Input | InputType | The Input Action or Input Axis asset to reset. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- Only the player's changes to that input are removed.
- **Success** is false when the input is not an Input Action or Input Axis in the project.
