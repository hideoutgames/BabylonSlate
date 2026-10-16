# Read Data Entry

Reads an entry's values from a Data Tree that is already loaded and returns a copy.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Tree | DataTree Asset | The Data Tree to read. |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root, such as Weapons/Swords/Iron Sword. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Structure |
| Found | Boolean |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | The Data Definition that the entry's values must match. It also shapes the **Value** output. |

## Notes

- **Found** is false, and **Value** empty, when the tree or entry is missing, the values are invalid, or the entry uses a different Data Definition.
- A tree chosen at run time must be loaded first, with [**Async Load Asset**](async-load-asset.md) or [**Read Data Entry Async**](read-data-entry-async.md).
- Changing **Value** never alters the authored data.
