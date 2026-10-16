# Lerp Color

Returns a colour blended between two colours, using Alpha as the mix amount.

## Inputs

| Pin | Type |
| --- | --- |
| A | Color |
| B | Color |
| Alpha | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Color |

## Notes

- **Alpha** is the blend amount, not opacity: 0 returns **A** and 1 returns **B**.
- Every channel is blended, including the alpha channel. The amount is not clamped, so values outside 0 to 1 go past **A** or **B**.
