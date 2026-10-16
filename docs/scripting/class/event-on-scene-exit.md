# Event On Scene Exit

Runs when the current scene is removed, for a scene change or when Play ends.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Scene Name | String | The display name of the scene that is exiting. |

## Notes

- Runs after the scene's own actors and Scene Subsystems have been torn down.
- Only in Game Instance and Game Subsystem classes.
