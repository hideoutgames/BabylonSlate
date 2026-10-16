---
node: input.bindings
---

# Get Input Bindings

Returns the current bindings of an Input Action or Input Axis.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Input | InputType | The Input Action or Input Axis asset to read. |

## Outputs

| Pin | Type |
| --- | --- |
| Bindings | Array of InputBinding |

## Notes

- Includes the player's changes as well as the authored bindings.
- Returns an empty array when the input is not a valid Input Action or Input Axis.
