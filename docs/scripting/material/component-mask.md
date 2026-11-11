---
node: vector.mask
---

# Component Mask (X)

Extracts chosen channels from a Vector4 and outputs them as a Float or a smaller vector.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Vector4 | (0, 0, 0, 0) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Settings

| Setting | Description |
| --- | --- |
| X | Include the first component (red of a colour). |
| Y | Include the second component (green). |
| Z | Include the third component (blue). |
| W | Include the fourth component (alpha). |

## Notes

- Choose the components with the X, Y, Z and W toggles in the **Inspector**. At least one must stay on.
- The output is a Float for one component, or a Vector2, 3 or 4 for more, in X, Y, Z, W order. [**Swizzle**](swizzle.md) reorders or repeats components.
- A Float input fills every channel. A narrower vector fills the missing channels with 1.
