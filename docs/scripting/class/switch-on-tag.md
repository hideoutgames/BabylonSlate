# Switch On Tag

Runs the output for the case that matches a Tag.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Tag | Tag |
| Exact Match | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Default | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Cases | The Tags to branch on. Each one adds its own output. |

## Notes

- **Default** runs when no case matches.
- **Exact Match** is on by default. With it off, a Tag also matches its parent categories, and the closest matching category wins.
