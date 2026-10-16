---
node: assets.getHandleProgress
---

# Get Load Handle Progress

Returns how much of a load has finished, from 0 to 1.

## Inputs

| Pin | Type |
| --- | --- |
| Handle | String |

## Outputs

| Pin | Type |
| --- | --- |
| Progress | Float |

## Notes

- Progress never goes down, and reaches 1 only when the handle is Loaded.
- A released or unknown handle reads 0.
