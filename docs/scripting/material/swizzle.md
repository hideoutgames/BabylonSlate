---
node: vector.swizzle
---

# Swizzle (XYZ)

Reorders or repeats the components of a vector.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Vector4 | (0, 0, 0, 0) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector3 |

## Settings

| Setting | Description |
| --- | --- |
| Component 1 | The input component that becomes the first output component: X, Y, Z or W. |
| Component 2 | The second output component, or None to end the vector here. |
| Component 3 | The third output component, or None. |
| Component 4 | The fourth output component, or None. |

## Notes

- The output is a Float for one component, or a Vector2, 3 or 4 for more.
- A component may be used more than once: ZZZ turns the third component into a Vector3.
- A Float input fills every component. A narrower vector fills the missing components with 1.
- [**Component Mask**](component-mask.md) keeps chosen components in their original order.
