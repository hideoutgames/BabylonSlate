---
node: transform.getComponentWorldRotation
---

# Get Component World Rotation

Returns the component's rotation in the world.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| World Rotation | Rotator |

## Notes

- The rotation is in the world, including its actor's and parent components' transforms.
- Rotations are in degrees.
- Includes any change Tweens, Timelines and [Set Component World Rotation](set-component-world-rotation.md) made.
- If **Target** is empty, the node returns the default value and logs an error.
