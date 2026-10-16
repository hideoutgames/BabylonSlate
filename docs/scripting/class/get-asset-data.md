---
node: assetRegistry.getAssetData
---

# Get Asset Data

Looks up an asset in the packaged asset catalog and returns its details.

## Inputs

| Pin | Type |
| --- | --- |
| Asset | Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Asset Data | AssetData |
| Found | Boolean |

## Notes

- **Found** is false, and **Asset Data** empty, when the catalog does not hold the asset.
- Use **Break Asset Data** to read its name, path, folder, type and Class.
- A running game's catalog holds packaged assets only; Editor Utility graphs see the whole project.
