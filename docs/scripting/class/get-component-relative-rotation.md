---
node: transform.getComponentRelativeRotation
---

# Get Component Relative Rotation

Returns the component's rotation relative to the component it is attached to, or to its actor.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Relative Rotation | Rotator |

## Notes

- The rotation is relative to the component it is attached to, or to its actor for a component attached to none.
- Rotations are in degrees.
- Includes any change Tweens, Timelines and [Set Component Relative Rotation](set-component-relative-rotation.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
