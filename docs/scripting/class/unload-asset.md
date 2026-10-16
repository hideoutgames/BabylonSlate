---
node: assets.unload
---

# Unload Asset

Releases the load handles that include an asset and belong to the calling object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Asset | Asset |  |
| Session Wide | Boolean | When on, releases the session's handles instead of the calling object's. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- A handle is released whole, so load assets in separate requests to unload them one at a time.
- Assets that other owners hold stay loaded, as do assets that sounds, spawned actors and material assignments load automatically.
