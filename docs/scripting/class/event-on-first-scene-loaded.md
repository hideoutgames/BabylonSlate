# Event On First Scene Loaded

Runs once per session when the first scene has finished loading.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Scene Name | String | The scene's display name, not its asset ID. |

## Notes

- Runs after [**Event On Scene Finish Loading**](event-on-scene-finish-loading.md) for that scene. It is a good place to call [**Load Game**](load-game.md).
- Only in Game Instance and Game Subsystem classes.
