# For Each Map

Runs Loop Body once for every key and value pair in a map.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Map | Map of Wildcard to Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Loop Body | Exec |  |
| Key | Wildcard | The key for the current pass. Its type matches the map. |
| Value | Wildcard | The value stored under that key. |
| Index | Integer | Position of the pair, starting at 0. |
| Completed | Exec |  |

## Notes

- Pairs are visited in the order they were added. An empty or missing map skips Loop Body and runs **Completed**.
- The loop works on a copy, so changing the map inside Loop Body does not change what is visited.
