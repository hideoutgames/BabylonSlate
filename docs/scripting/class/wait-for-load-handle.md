---
node: assets.waitForHandle
---

# Wait For Load Handle

Waits for a load handle to finish loading while gameplay continues.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Handle | String | The handle from an async load node or [**Request Async Load**](request-async-load.md). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Error | String | Why the load failed. Empty when it succeeded. |

## Notes

- Runs **Completed** when the handle is Loaded, at once if it already is.
- Runs **Failed** with the stored **Error** when the load failed, or when the handle was released or never existed.
- Latent: the node finishes later without pausing the rest of the game.
