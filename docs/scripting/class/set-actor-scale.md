---
node: transform.setScale
---

# Set Actor Scale

Sets the scale of an actor on each axis.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Scale | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A scale of 1 on an axis keeps the original size.
- A value that is not a finite number changes nothing.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens and an error is logged.
