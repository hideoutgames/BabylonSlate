---
node: flow.switchString
---

# Switch on String

Runs the output whose text matches a string value, or Default if none match.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Value | String |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Default | Exec | Runs when Value matches none of the cases. |

## Settings

| Setting | Description |
| --- | --- |
| Cases | The text values to match. Each value adds an output pin. |

## Notes

- Add the strings you want to match to **Cases**. Matching is case-sensitive.
- Empty and duplicate cases are removed.
