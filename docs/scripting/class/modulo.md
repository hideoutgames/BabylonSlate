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

- Each operand is an Integer or a Float. Connect a wire to an operand and it takes the wire's type, unless the operand already has a type the wire fits: an Integer wired into a Float operand keeps it a Float. On a new node, connecting one operand gives the other operand the same type while that one is unconnected and has no value of its own. For an unconnected operand, pick the type with **A Type** or **B Type** in the **Inspector**, or right-click the pin and choose a type under **Convert Pin**. A connected operand offers only the types its wire fits there: an operand with an Integer wire can be an Integer or a Float.
- **Out** is an Integer when both operands are Integers, else a Float.
- The result has the sign of **A**. A **B** of zero gives 0.
