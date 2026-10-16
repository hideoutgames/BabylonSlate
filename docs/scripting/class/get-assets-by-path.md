# Get Assets By Path

Lists the assets in a folder, sorted by path.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Folder | String | A storage folder such as assets/Weapons. Matching is case sensitive, and leading and trailing slashes are ignored. |
| Recursive | Boolean |  |

## Outputs

| Pin | Type |
| --- | --- |
| Assets | Array of AssetData |

## Notes

- **Recursive** includes assets in subfolders.
- An empty **Folder** with **Recursive** on lists every asset.
