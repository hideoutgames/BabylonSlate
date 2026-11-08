---
node: transform.getComponentRelativeLocation
---

# Get Component Relative Location

Returns the component's location relative to the component it is attached to, or to its actor.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Relative Location | Vector 3 |

## Notes

- The location is relative to the component it is attached to, or to its actor for a component attached to none.
- Includes any change Tweens, Timelines and [Set Component Relative Location](set-component-relative-location.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
