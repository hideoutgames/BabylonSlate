---
node: flow.switchInt
---

# Switch on Int

Runs the output whose number matches an integer value, or Default if none match.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Value | Integer |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Default | Exec | Runs when Value matches none of the cases. |

## Settings

| Setting | Description |
| --- | --- |
| Cases | The integer values to match. Each value adds an output pin. |

## Notes

- Add the integers you want to match to **Cases**. Each case gets its own output.
- Empty, duplicate and non-integer cases are removed.
