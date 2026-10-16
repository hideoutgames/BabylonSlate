# Get Sub Folders

Lists the full paths of the folders below a folder.

## Inputs

| Pin | Type |
| --- | --- |
| Folder | String |
| Recursive | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Folders | Array of String |

## Notes

- **Recursive** includes folders at every depth, not only direct children.
- A running game knows only the folders of packaged assets, so an empty folder does not exist there.
