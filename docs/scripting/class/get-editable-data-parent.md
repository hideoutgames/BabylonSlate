---
node: editorData.getParent
---

# Get Editable Data Parent

Returns the path of an entry's parent, including unsaved edits.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |
| Failed | Exec |
| Error | String |
| Parent Path | String |

## Notes

- A top-level entry returns an empty path; a missing entry fails.
- Only in Editor Utility graphs; use the path from **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
