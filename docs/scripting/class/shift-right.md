---
node: math.shiftRight
---

# Shift Right

Moves an integer's bits toward the low end.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Integer |  |
| Shift | Integer | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Integer |

## Notes

- Each place halves the value, rounding down and keeping its sign: -8 shifted by 1 is -4.
