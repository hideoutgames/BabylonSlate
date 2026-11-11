---
node: logic.select
---

# Select

Chooses between When True and When False using Condition.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Condition | Any | 0 |
| When True | Any | 0 |
| When False | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Returns When True when Condition is greater than 0.5, and When False otherwise.
- A Float Condition picks the whole value. A vector Condition picks each channel by its own channel, so a comparison of two colours selects per channel.
- Connect a comparison node such as [**Greater Than**](greater-than.md) to Condition.
