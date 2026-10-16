# While Loop

Repeats Loop Body for as long as Condition is true.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Condition | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Loop Body | Exec |
| Completed | Exec |

## Notes

- Condition is checked before every pass; when it is false, **Completed** runs.
- Use [**Break**](break.md) to leave early; the editor warns when Condition is always true.
- With **Infinite Loop Detection** on in **Project Settings &gt; General**, a runaway loop is stopped in Play and Preview.
