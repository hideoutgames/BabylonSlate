---
node: flow.forEachMapWithBreak
---

# For Each Map With Break

Runs Loop Body once for every key and value pair in a map, and can stop early.

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

- Connect [**Break**](break.md) inside Loop Body to leave the loop early. **Completed** then runs.
- The loop works on a copy, so changing the map inside Loop Body does not change what is visited.
