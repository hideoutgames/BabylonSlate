---
node: curveObject.getVector
---

# Get Vector Curve Object

Returns the read-only object for a Vector Curve asset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Curve Asset | Vector Curve Asset | The curve asset to read. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Object | Vector Curve Object | None while the asset is not loaded. |

## Notes

- There is one object per asset for the session; it is never collected, so you can keep it in variables and pass it into functions.
- The asset given here loads with the asset that uses this node.
- See [Curve](../../assets/curve.md).
