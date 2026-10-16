---
node: editorData.createTree
---

# Create Data Tree

Creates a new, empty Data Tree asset in the project.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Name | String | The name of the new Data Tree asset. |
| Folder | String | A folder inside the project's content, such as Data/Items. Empty uses the content root. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |
| Error | String |
| Data Tree | DataTree Asset |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | The tree's default Data Definition, which new entries inherit. Leave it empty for none. |

## Notes

- **Folder** is relative to the project's content folder and cannot climb out of it.
- An existing asset is never overwritten, and the new tree is saved straight away.
- Only in Editor Utility graphs; check **Success** before using the tree.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
