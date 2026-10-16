---
node: transform.setLocation
---

# Set Actor Location

Moves an actor to a new location.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Location | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The location is in world units. For an attached actor, it is relative to the parent.
- A value that is not a finite number changes nothing.
