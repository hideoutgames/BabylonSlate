---
node: assets.asyncLoad
---

# Async Load Asset

Loads an asset and its required dependencies in the background while gameplay continues.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Asset | Asset |  |
| Priority | AssetLoadPriority | How urgent the load is: Low, Normal or High. Normal by default. |
| Session Wide | Boolean | When on, the load belongs to the session instead of the calling object. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Asset | Asset | The same asset that went in, so you can keep using it after the load. |
| Handle | String | Identifies this load. Use it with [**Get Load Handle State**](get-load-handle-state.md), [**Get Load Handle Progress**](get-load-handle-progress.md) and [**Release Load Handle**](release-load-handle.md). |
| Error | String | Why the load failed. Empty when it succeeded. |

## Notes

- Runs **Completed** when the asset is ready, or **Failed** with an **Error** if it cannot load.
- **Soft (Load On Demand)** references need this; **Hard (Load With Owner)** references already load with their owner.
- The load belongs to the calling object until you release it, that object is destroyed or Play stops.
- Latent: the node finishes later without pausing the rest of the game.
