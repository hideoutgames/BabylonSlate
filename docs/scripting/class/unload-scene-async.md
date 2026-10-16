# Unload Scene Async

Starts unloading a Scene Streaming Actor's Scene while the game keeps running.

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

- **Then** runs straight away. Only that streamed instance, and any Scenes streamed inside it, are removed.
- A load still in progress is cancelled.
