---
node: tags.has
---

# Has Tag

Returns true when a TagContainer holds a Tag, or a child of that Tag.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Container | TagContainer |  |
| Tag | Tag |  |
| Exact Match | Boolean | When on, the container must hold the identical Tag. |

## Outputs

| Pin | Type |
| --- | --- |
| Result | Boolean |

## Notes

- A container holding `State.Combat.Attacking` has `State.Combat`, unless **Exact Match** is on.
- None and Tags that no longer exist in the project never match.
