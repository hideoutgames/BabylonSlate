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

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- The location is in world units. For an attached actor, it is relative to the parent.
- A value that is not a finite number changes nothing.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens and an error is logged.
