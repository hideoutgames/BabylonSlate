# Select

Chooses between When True and When False using Condition.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Condition | Float | 0 |
| When True | Any | 0 |
| When False | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Returns When True when Condition is greater than 0.5, and When False otherwise.
- Connect a comparison node such as [**Greater Than**](greater-than.md) to Condition.
