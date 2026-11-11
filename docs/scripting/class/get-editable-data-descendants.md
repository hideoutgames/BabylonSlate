---
node: editorData.getDescendants
---

# Get Editable Data Descendants

Returns the paths of every entry below an entry, including unsaved edits.

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

- Parents are listed before their children. An empty **Entry Path** selects the tree root, and a missing entry fails.
- Only in Editor Utility graphs; use the paths from **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
