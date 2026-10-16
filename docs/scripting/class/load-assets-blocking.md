# Load Assets Blocking

Loads several assets together at High priority and pauses the game until loading finishes.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Assets | Array of Asset |  |
| Session Wide | Boolean | When on, the load belongs to the session instead of the calling object. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Assets | Array of Asset | The same assets that went in, so you can keep using them after the load. |
| Handle | String | Identifies this load. Use it with [**Get Load Handle State**](get-load-handle-state.md) and [**Release Load Handle**](release-load-handle.md). |
| Error | String | Why the load failed. Empty when it succeeded. |

## Notes

- Ticks, physics, timers and tweens stop while it loads; loading and rendering preparation continue.
- Runs **Completed** when every asset is ready, or **Failed** with an **Error** if any cannot load.
- The load belongs to the calling object until you release it, that object is destroyed or Play stops.
- Latent: the node finishes later without pausing the rest of the game.
