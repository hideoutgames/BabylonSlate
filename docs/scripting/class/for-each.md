# For Each

Runs Loop Body once for every element of an array.

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

- Elements are visited in order. An empty or missing array skips Loop Body and runs **Completed**.
- The loop works on a copy, so changing the array inside Loop Body does not change what is visited.
