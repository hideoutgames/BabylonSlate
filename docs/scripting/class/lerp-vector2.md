---
node: vector.lerp2
---

# Lerp Vector2

Blends between two vectors using a factor from 0 to 1.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Vector 2 |  |
| B | Vector 2 |  |
| Alpha | Float | At 0 the result is **A**; at 1 the result is **B**. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 2 |

## Notes

- **Alpha** is not limited to 0 to 1. Values outside that range continue past **A** or **B**.
