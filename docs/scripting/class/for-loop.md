# For Loop

Runs Loop Body once for each integer from First Index to Last Index.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| First Index | Integer |
| Last Index | Integer |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Loop Body | Exec |  |
| Index | Integer | The number for the current pass. |
| Completed | Exec |  |

## Notes

- Both indices are included. If Last Index is lower than First Index, Loop Body does not run.
- **Completed** runs once after the final pass.
