# Event On Streamed Scene Loaded

Runs on a Scene Subsystem when a streamed sub-scene becomes ready.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Streaming Actor | SceneStreamingActor Reference | The Scene Streaming Actor that loaded the sub-scene. |
| Scene | Scene Reference | The sub-scene that became ready. |

## Notes

- Runs after the sub-scene's actors have begun play.
- Only in Scene Subsystem classes.
