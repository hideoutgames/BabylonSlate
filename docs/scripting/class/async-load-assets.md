# Async Load Assets

Loads several assets and their required dependencies as one request while gameplay continues.

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
| Completed | Exec |  |
| Failed | Exec |  |
| Assets | Array of Asset | The same assets that went in, so you can keep using them after the load. |
| Handle | String | Identifies this load. Use it with [**Get Load Handle State**](get-load-handle-state.md), [**Get Load Handle Progress**](get-load-handle-progress.md) and [**Release Load Handle**](release-load-handle.md). |
| Error | String | Why the load failed. Empty when it succeeded. |

## Notes

- Runs **Completed** when every asset is ready; if any cannot load, it runs **Failed** with an **Error** and none stay loaded.
- **Soft (Load On Demand)** references need this; **Hard (Load With Owner)** references already load with their owner.
- The load belongs to the calling object until you release it, that object is destroyed or Play stops.
- Latent: the node finishes later without pausing the rest of the game.
