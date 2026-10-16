---
node: assetRegistry.getDependencies
---

# Get Asset Dependencies

Lists the catalog assets that an asset references, sorted by path.

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

- **Hard Only** keeps only the references that load with the asset.
- References to assets outside the catalog are left out, and an asset the catalog does not hold gives an empty list.
