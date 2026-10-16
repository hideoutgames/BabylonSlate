# Request Async Load

Starts loading assets in the background and returns a handle at once, without waiting.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Assets | Array of Asset |  |
| Priority | AssetLoadPriority | How urgent the load is: Low, Normal or High. Normal by default. |
| Session Wide | Boolean | When on, the load belongs to the session instead of the calling object. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Handle | String | Identifies this load. It reads Loading until the assets are ready. |

## Notes

- Follow it with [**Wait For Load Handle**](wait-for-load-handle.md), [**Get Load Handle State**](get-load-handle-state.md) or [**Get Load Handle Progress**](get-load-handle-progress.md).
- An empty list of assets is Loaded straight away.
- The load belongs to the calling object until you release it, that object is destroyed or Play stops.
