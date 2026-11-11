---
node: transform.getComponentWorldLocation
---

# Get Component World Location

Returns the component's location in the world.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| World Location | Vector3 |

## Notes

- The location is in the world, including its actor's and parent components' transforms.
- Includes any change Tweens, Timelines and [Set Component World Location](set-component-world-location.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
