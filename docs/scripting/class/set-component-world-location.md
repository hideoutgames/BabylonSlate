---
node: transform.setComponentWorldLocation
---

# Set Component World Location

Sets the component's location in the world; it stays attached and keeps that place until its parent moves.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Component Reference |
| New Location | Vector3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The new location is in the world, including its actor's and parent components' transforms.
- The component stays attached: when its parent moves later, it moves with it.
- A new place for a collider's component moves its collision too.
- A value that is not a finite number changes nothing.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
