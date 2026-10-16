---
node: assetRegistry.findAssets
---

# Find Assets

Lists the assets that match every part of a filter, sorted by path.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Filter | AssetFilter | Build the filter with **Make Asset Filter**. |

## Outputs

| Pin | Type |
| --- | --- |
| Assets | Array of AssetData |

## Notes

- Each part you set must match: folders, types, Classes and a name fragment that ignores case. A part left empty does not limit the search.
- A running game lists packaged assets only. Add a folder to **Project Settings &gt; Export &gt; Always Package Folders** to include assets that nothing references.
