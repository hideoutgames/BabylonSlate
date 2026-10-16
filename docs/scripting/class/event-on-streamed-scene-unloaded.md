---
node: flow.event.streamedSceneUnloaded
---

# Event On Streamed Scene Unloaded

Runs on a Scene Subsystem when a streamed sub-scene is unloaded.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Streaming Actor | SceneStreamingActor Reference | The Scene Streaming Actor that owned the sub-scene. |
| Scene | Scene Reference | The sub-scene that was unloaded. |

## Notes

- Only runs for sub-scenes that were reported by [**Event On Streamed Scene Loaded**](event-on-streamed-scene-loaded.md).
- Only in Scene Subsystem classes.
