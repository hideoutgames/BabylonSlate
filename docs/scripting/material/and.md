---
node: logic.and
---

# And

Returns 1 where both A and B are true and 0 otherwise.

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
- Use it to combine two masks from comparison nodes such as [**Greater Than**](greater-than.md).
