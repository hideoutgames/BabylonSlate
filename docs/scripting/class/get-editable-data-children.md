---
node: editorData.getChildren
---

# Get Editable Data Children

Returns the paths of an entry's immediate children in order, including unsaved edits.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Entry Path | String | The entry's exact, case-sensitive name path. Empty selects the tree root. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |
| Failed | Exec |
| Error | String |
| Entry Paths | Array of String |

## Notes

- An empty **Entry Path** selects the tree root. A missing entry fails.
- Only in Editor Utility graphs; use the paths from **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
