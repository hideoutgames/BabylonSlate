# Read Editable Data Entry

Reads the values of one Data Tree entry, including unsaved edits.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |
| Error | String |
| Value | Structure |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | The Data Definition that the entry must use. It also shapes the **Value** output. |

## Notes

- Fails if the entry has no Data Definition, uses a different one from the node, or has invalid values.
- Check **Success** before using **Value**.
- Only in Editor Utility graphs.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
