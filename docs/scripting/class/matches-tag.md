# Matches Tag

Returns true when a Tag is the same as, or a child of, a query Tag.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Tag | Tag |  |
| Query | Tag | The Tag or parent category to test against. |
| Exact Match | Boolean | When on, only the identical Tag matches and parent categories do not. |

## Outputs

| Pin | Type |
| --- | --- |
| Result | Boolean |

## Notes

- `State.Combat.Attacking` matches `State.Combat`, but `State.Combat` does not match `State.Combat.Attacking`.
- None, and Tags that no longer exist in the project, never match.
