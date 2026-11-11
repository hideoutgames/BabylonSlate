---
node: logic.or
---

# Or

Returns 1 where A or B is true and 0 where neither is.

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

- A value above 0.5 is true, as [**Select**](select.md) reads its Condition.
- Each channel is tested separately.
