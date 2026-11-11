---
node: math.wrap
---

# Wrap

Keeps a number within a range by wrapping it round.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |
| Min | Float | Defaults to 0. |
| Max | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- Past **Max** the value starts again from **Min**, like an angle past 360. 370 in 0 to 360 returns 10.
- Returns **Min** when **Max** is not above **Min**.
