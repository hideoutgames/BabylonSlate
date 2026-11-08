---
node: transform.getComponentWorldScale
---

# Get Component World Scale

Returns the component's scale in the world.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| World Scale | Vector 3 |

## Notes

- The scale is in the world, including its actor's and parent components' transforms.
- Includes any change Tweens, Timelines and [Set Component World Scale](set-component-world-scale.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
