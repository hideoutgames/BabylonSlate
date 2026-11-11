---
node: logic.not
---

# Not

Returns 0 where Value is true and 1 where it is not.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- A value above 0.5 is true, as [**Select**](select.md) reads its Condition.
- Each channel is tested separately.
- [**One Minus**](one-minus.md) gives the same result for a mask that is exactly 0 or 1, and keeps the values in between.
