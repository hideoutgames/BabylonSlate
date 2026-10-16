# Select By Tag

Returns the value that belongs to the case matching a Tag.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Tag | Tag |  |
| Exact Match | Boolean |  |
| Default | Wildcard | The value returned when no case matches. |

## Outputs

| Pin | Type |
| --- | --- |
| Result | Wildcard |

## Settings

| Setting | Description |
| --- | --- |
| Cases | The Tags to choose between. Each one adds its own value input. |

## Notes

- Returns **Default** when no case matches.
- **Exact Match** is on by default. With it off, a Tag also matches its parent categories, and the closest matching category wins.
