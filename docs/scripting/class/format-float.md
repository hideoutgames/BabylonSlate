---
node: string.formatFloat
---

# Format Float

Turns a number into text with a fixed number of decimals.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |
| Decimals | Integer | Defaults to 2. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | String |

## Notes

- The number is rounded: 3.14159 with 2 decimals returns "3.14". **Decimals** is limited to 0 to 20.
