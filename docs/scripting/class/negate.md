---
node: math.negate
---

# Negate

Flips the sign of a number, or points a vector the opposite way.

## Inputs

| Pin | Type |
| --- | --- |
| In | Integer, Float, Vector2, Vector3 or Vector4 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Integer, Float, Vector2, Vector3 or Vector4 |

## Notes

- **In** takes the type of the wire connected to it, unless it already has a type the wire fits: an Integer wired into a Float **In** keeps it a Float. When it is unconnected, pick the type with **Value Type** in the **Inspector**.
- **Out** has the type of **In**. A vector has every component negated.
