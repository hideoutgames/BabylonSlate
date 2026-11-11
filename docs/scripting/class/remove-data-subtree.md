---
node: editorData.removeEntry
---

# Remove Data Subtree

Removes an entry and everything below it from a Data Tree.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Entry Path | String | The exact name path of the entry to remove. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Error | String | Why the node failed; empty on success. |
| Entry Path | String | The path of the removed entry. |

## Notes

- The removal is one undoable edit, and undo on the tree restores the whole subtree.
- A missing entry fails.
- Only in Editor Utility graphs; use **Entry Path** from **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
