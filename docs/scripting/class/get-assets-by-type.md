# Get Assets By Type

Lists the assets of one type, sorted by path.

## Inputs

| Pin | Type |
| --- | --- |
| Type | AssetType |
| Folder | String |
| Recursive | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Assets | Array of AssetData |

## Notes

- **Folder** limits the search; empty searches every folder.
- **Recursive** is on by default, so subfolders are included.
