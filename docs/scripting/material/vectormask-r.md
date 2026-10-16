# VectorMask(R)

Extracts chosen channels from a Vector 4 and outputs them as a Float or a smaller vector.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Vector 4 | (0, 0, 0, 0) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Settings

| Setting | Description |
| --- | --- |
| R | Include the red (first) channel. |
| G | Include the green (second) channel. |
| B | Include the blue (third) channel. |
| A | Include the alpha (fourth) channel. |

## Notes

- Choose the channels with the R, G, B and A toggles in the **Inspector**. At least one must stay on.
- The output is a Float for one channel, or a Vector 2, 3 or 4 for more, in R, G, B, A order.
- A narrower input fills the missing channels with 1.
