# Async Load Class

Loads a Class, with its scripts and required resources, in the background while gameplay continues.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Class | Object Class | A Class from the project. Engine Classes have nothing to load and complete at once. |
| Priority | AssetLoadPriority | How urgent the load is: Low, Normal or High. Normal by default. |
| Session Wide | Boolean | When on, the load belongs to the session instead of the calling object. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Handle | String | Identifies this load. Use it with [**Get Load Handle State**](get-load-handle-state.md), [**Get Load Handle Progress**](get-load-handle-progress.md) and [**Release Load Handle**](release-load-handle.md). |
| Error | String | Why the load failed. Empty when it succeeded. |

## Notes

- Runs **Completed** when the Class is ready, or **Failed** with an **Error** if it cannot load.
- A loaded Class lets [**Spawn Actor**](spawn-actor.md) create it without waiting.
- The load belongs to the calling object until you release it, that object is destroyed or Play stops.
- Latent: the node finishes later without pausing the rest of the game.
