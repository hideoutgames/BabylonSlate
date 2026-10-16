---
node: assets.releaseHandle
---

# Release Load Handle

Cancels a load that is still pending and releases the handle's hold on its assets.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Handle | String |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- The handle then reads Released.
- Assets that other owners hold stay loaded.
