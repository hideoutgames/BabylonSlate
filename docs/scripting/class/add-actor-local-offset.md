---
node: transform.addLocalOffset
---

# Add Actor Local Offset

Moves the actor along its own axes, as its rotation turns them; its scale does not stretch the move.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Delta Location | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- [Add World Offset](add-world-offset.md) moves along the world's axes instead.
- For an attached actor, the move is made relative to its parent.
- A value that is not a finite number changes nothing.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
