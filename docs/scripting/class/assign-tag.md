---
node: tags.assign
---

# Assign Tag

Assigns a Tag to a variable and returns the assigned Tag.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | Tag | The Tag variable to change, wired from its Get node. |
| Value | Tag |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Value | Tag | The Tag that was assigned. |

## Notes

- Connect a variable's Get node to **Target**; the new Tag is written back to that variable.
