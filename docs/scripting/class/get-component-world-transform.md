---
node: transform.getComponentWorldTransform
---

# Get Component World Transform

Returns the component's transform in the world.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| World Transform | Transform |

## Notes

- The transform is in the world, including its actor's and parent components' transforms.
- Includes any change Tweens, Timelines and [Set Component World Transform](set-component-world-transform.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
