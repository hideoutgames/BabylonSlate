---
node: string.findSubstring
---

# Find Substring

Returns where a piece of text first appears in a string.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Search In | String |  |
| Substring | String |  |
| Search From End | Boolean | Off by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Index | Integer |

## Notes

- Positions count from 0. Returns -1 when **Substring** is not found.
- **Search From End** returns the last place it appears instead. The search matches letter case exactly.
