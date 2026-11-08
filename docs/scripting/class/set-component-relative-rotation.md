---
node: transform.setComponentRelativeRotation
---

# Set Component Relative Rotation

Sets the component's rotation relative to the component it is attached to, or to its actor.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Component Reference |
| New Rotation | Rotator |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The new rotation is relative to the component it is attached to, or to its actor for a component attached to none.
- Rotations are in degrees.
- A new place for a collider's component moves its collision too.
- A value that is not a finite number changes nothing.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
