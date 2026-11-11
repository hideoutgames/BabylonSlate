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
| Completed | Exec |
| Failed | Exec |
| Error | String |
| Data Trees | Array of DataTree Asset |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | Limits the list to trees that use this Data Definition. Leave it empty to list every tree. |

## Notes

- Only in Editor Utility graphs; **Completed** or **Failed** runs when the operation finishes; **Error** says why it failed.
- A tree matches when its default Definition, or any entry's effective Definition, is the chosen one.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
