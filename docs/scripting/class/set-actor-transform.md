---
node: transform.set
---

# Set Actor Transform

Sets an actor's location, rotation and scale from one transform.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Transform | Transform |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- For an attached actor, the transform is relative to its parent.
- If any part of the transform is not a finite number, nothing changes.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens.
