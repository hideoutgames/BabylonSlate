# Event On Scene Finish Loading

Runs each time a scene has finished loading.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Scene Name | String | The display name of the scene that finished loading. |

## Notes

- Runs for every scene change, not only the first. Use [**Event On First Scene Loaded**](event-on-first-scene-loaded.md) for startup work.
- Only in Game Instance and Game Subsystem classes.
