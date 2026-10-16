---
node: math.lerp
---

# Lerp

Blends from one value to another by an amount between 0 and 1.

## Inputs

| Pin | Type |
| --- | --- |
| A | Float |
| B | Float |
| Alpha | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- An **Alpha** of 0 returns **A**, 1 returns **B**, and values in between blend in a straight line.
- **A** and **B** can be a Float, Vector 2, Vector 3 or Color, while **Alpha** is always a Float.
