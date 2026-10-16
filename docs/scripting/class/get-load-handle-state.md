---
node: assets.getHandleState
---

# Get Load Handle State

Returns whether a load handle is Loading, Loaded, Failed or Released.

## Inputs

| Pin | Type |
| --- | --- |
| Handle | String |

## Outputs

| Pin | Type |
| --- | --- |
| State | AssetLoadHandleState |

## Notes

- A Failed handle stays readable until you release it.
- A released or unknown handle reads Released.
