---
node: logic.lessThan
---

# Less Than

Returns 1 where A is less than B and 0 otherwise.

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

- Each channel is compared separately.
- Connect the result to **Condition** on [**Select**](select.md).
