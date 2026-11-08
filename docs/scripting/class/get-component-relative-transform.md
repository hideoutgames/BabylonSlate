---
node: transform.getComponentRelativeTransform
---

# Get Component Relative Transform

Returns the component's transform relative to the component it is attached to, or to its actor.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Relative Transform | Transform |

## Notes

- The transform is relative to the component it is attached to, or to its actor for a component attached to none.
- Includes any change Tweens, Timelines and [Set Component Relative Transform](set-component-relative-transform.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
