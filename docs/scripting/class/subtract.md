---
node: math.sub
---

# Subtract

Returns the first number or vector minus the second.

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

- Each operand has its own type: Integer, Float, Vector2, Vector3 or Vector4. Connect a wire to an operand and it takes the wire's type, unless the operand already has a type the wire fits: an Integer wired into a Float operand keeps it a Float. On a new node, connecting one operand gives the other operand the same type while that one is unconnected and has no value of its own. For an unconnected operand, pick the type with **A Type** or **B Type** in the **Inspector**, or right-click the pin and choose a type under **Convert Pin**. A connected operand offers only the types its wire fits there: an operand with an Integer wire can be an Integer or a Float.
- Two vectors must be the same size. A number with a vector works on every component.
- **Out** is an Integer when both operands are Integers, a Float for any other two numbers, and the vector when either operand is a vector.
- With a vector and a number, the subtraction happens on every component, in the order of **A** and **B**.
