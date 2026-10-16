---
node: assetRegistry.getReferencers
---

# Get Asset Referencers

Lists the catalog assets that reference an asset, sorted by path.

## Inputs

| Pin | Type |
| --- | --- |
| Asset | Asset |
| Hard Only | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Assets | Array of Asset |

## Notes

- **Hard Only** keeps only the references that load with their owner.
- Only assets in the catalog are checked.
