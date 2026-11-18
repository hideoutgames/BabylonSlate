---
node: math.mul
---

# Multiply

Returns the product of two numbers or vectors.

## Inputs

| Pin | Type |
| --- | --- |
| A | Integer, Float, Vector2, Vector3 or Vector4 |
| B | Integer, Float, Vector2, Vector3 or Vector4 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Integer, Float, Vector2, Vector3 or Vector4 |

## Notes

- Each operand has its own type: Integer, Float, Vector2, Vector3 or Vector4. Connect a wire to an operand and it takes the wire's type; for an unconnected operand, pick the type with **A Type** or **B Type** in the **Inspector**.
- Two vectors must be the same size. A number with a vector works on every component.
- **Out** is an Integer when both operands are Integers, a Float for any other two numbers, and the vector when either operand is a vector.
- Two vectors multiply component by component. A number scales a vector: a negative one reverses it.
