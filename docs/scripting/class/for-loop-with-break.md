# For Loop With Break

Runs Loop Body once for each integer from First Index to Last Index, and can stop early.

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

- Both indices are included. Connect [**Break**](break.md) inside Loop Body to leave the loop early.
- **Completed** runs after the final pass, or after a Break.
