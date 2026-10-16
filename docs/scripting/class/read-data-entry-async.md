# Read Data Entry Async

Loads a Data Tree and its Data Definition in the background, then reads one entry from it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Tree | DataTree Asset | The Data Tree to read. |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root, such as Weapons/Swords/Iron Sword. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |
| Failed | Exec |
| Value | Structure |
| Found | Boolean |
| Error | String |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | The Data Definition that the entry's values must match. It also shapes the **Value** output. |

## Notes

- Runs **Completed** once the read finishes, even when **Found** is false; runs **Failed** with an **Error** only if the tree cannot be loaded.
- **Value** is a copy, so changing it never alters the authored data.
- Use it for a tree chosen at run time. A tree fixed on the node loads with its Class and can use [**Read Data Entry**](read-data-entry.md).
- Latent: the node finishes later without pausing the rest of the game.
