---
node: math.nlerp
---

# Normalized Lerp

Blends from one direction to another by an amount between 0 and 1 and returns the result at length 1.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Any | 0 |
| B | Any | 1 |
| Alpha | Float | 0.5 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- **A**, **B** and **Out** are a Vector2 or a Vector3 (Vector3 until a vector is wired).
- It blends like [Lerp](lerp.md), then scales the result to length 1, so it suits directions. A result of length 0 stays 0.
