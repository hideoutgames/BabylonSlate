# For Each With Break

Runs Loop Body once for every element of an array, and can stop early.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Array | Array of Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Loop Body | Exec |  |
| Element | Wildcard | The array element for the current pass. Its type matches the array. |
| Index | Integer | Position of the element in the array, starting at 0. |
| Completed | Exec |  |

## Notes

- Connect [**Break**](break.md) inside Loop Body to leave the loop early. **Completed** then runs.
- The loop works on a copy, so changing the array inside Loop Body does not change what is visited.
