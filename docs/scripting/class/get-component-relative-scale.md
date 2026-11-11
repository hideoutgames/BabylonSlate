---
node: transform.getComponentRelativeScale
---

# Get Component Relative Scale

Returns the component's scale relative to the component it is attached to, or to its actor.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Relative Scale | Vector3 |

## Notes

- The scale is relative to the component it is attached to, or to its actor for a component attached to none.
- Includes any change Tweens, Timelines and [Set Component Relative Scale](set-component-relative-scale.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
