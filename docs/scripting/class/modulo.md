---
node: math.mod
---

# Modulo

Returns the remainder after dividing one number by another.

## Inputs

| Pin | Type |
| --- | --- |
| A | Integer or Float |
| B | Integer or Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Integer or Float |

## Notes

- Each operand is an Integer or a Float. Connect a wire to an operand and it takes the wire's type; for an unconnected operand, pick the type with **A Type** or **B Type** in the **Inspector**.
- **Out** is an Integer when both operands are Integers, else a Float.
- The result has the sign of **A**. A **B** of zero gives 0.
