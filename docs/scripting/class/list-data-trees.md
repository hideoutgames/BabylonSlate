---
node: editorData.listTrees
---

# List Data Trees

Lists the Data Trees in the project, optionally only those that use a chosen Data Definition.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |
| Error | String |
| Data Trees | Array of DataTree Asset |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | Limits the list to trees that use this Data Definition. Leave it empty to list every tree. |

## Notes

- Only in Editor Utility graphs; **Then** runs when the operation finishes, so check **Success** and read **Error** if it is false.
- A tree matches when its default Definition, or any entry's effective Definition, is the chosen one.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
