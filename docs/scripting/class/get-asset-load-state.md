---
node: assets.getLoadState
---

# Get Asset Load State

Returns whether an asset is Unloaded, Loading, Loaded or Failed.

## Inputs

| Pin | Type |
| --- | --- |
| Asset | Asset |

## Outputs

| Pin | Type |
| --- | --- |
| State | AssetLoadState |

## Notes

- Loaded means the asset's resources are prepared and ready to use.
- An asset that nothing has loaded reads Unloaded.
