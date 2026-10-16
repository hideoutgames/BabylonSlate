---
node: logic.equal
---

# Equal

Returns 1 where A equals B and 0 where it does not.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Any | 0 |
| B | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Each channel is compared separately and exactly, so calculated values can differ by tiny amounts.
- Connect the result to **Condition** on [**Select**](select.md).
