# Load Scene Async

Starts loading a Scene Streaming Actor's Scene while the game keeps running.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Target | SceneStreamingActor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- **Then** runs straight away; follow the load with [**Get Scene State**](get-scene-state.md), [**Get Scene Load Progress**](get-scene-load-progress.md) or [**Is Scene Loaded**](is-scene-loaded.md).
- A load that fails logs an error and the graph continues.
- The streamed Scene must use the same Physics World as the Scene that loads it.
