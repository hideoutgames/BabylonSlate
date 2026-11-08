---
node: transform.setComponentRelativeScale
---

# Set Component Relative Scale

Sets the component's scale relative to the component it is attached to, or to its actor.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Component Reference |
| New Scale | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The new scale is relative to the component it is attached to, or to its actor for a component attached to none.
- A new place for a collider's component moves its collision too.
- A value that is not a finite number changes nothing.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
