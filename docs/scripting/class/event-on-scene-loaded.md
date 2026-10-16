---
node: flow.event.sceneLoaded
---

# Event On Scene Loaded

Runs on a Scene Subsystem after its scene has finished loading.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Scene Name | String | The scene's display name, not its asset ID. |

## Notes

- Runs after the Game Instance and Game Subsystems have heard [**Event On Scene Finish Loading**](event-on-scene-finish-loading.md), so after every actor's [**Event Begin Play**](event-begin-play.md) in the scene.
- Only in Scene Subsystem classes.
