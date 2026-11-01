---
node: curveObject.getColor
---

# Get Color Curve Object

Returns the read-only object for a Color Curve asset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Curve Asset | Color Curve Asset | The curve asset to read. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Object | Color Curve Object | None while the asset is not loaded. |

## Notes

- There is one object per asset for the session; it is never collected, so you can keep it in variables and pass it into functions.
- The asset given here loads with the asset that uses this node.
- See [Curve](../../assets/curve.md).
