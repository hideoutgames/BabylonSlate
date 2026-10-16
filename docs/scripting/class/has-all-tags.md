---
node: tags.hasAll
---

# Has All Tags

Returns true when a TagContainer matches every Tag in a second TagContainer.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Container | TagContainer |  |
| Queries | TagContainer | The Tags to look for. |
| Exact Match | Boolean | When on, only identical Tags match and parent categories do not. |

## Outputs

| Pin | Type |
| --- | --- |
| Result | Boolean |

## Notes

- An empty **Queries** container returns true.
- Child Tags count as matches for their parent categories unless **Exact Match** is on.
