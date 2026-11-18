---
node: math.div
---

# Divide

Returns the first number or vector divided by the second.

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
- Two Integers divide to a whole number, rounded toward zero: -7 divided by 2 gives -3.
- Vectors divide component by component. A number divides every component of a vector, and a vector divides a number component by component.
- Dividing by zero gives 0, for each component of a vector that is zero, and for the whole vector when a number **B** is zero.
