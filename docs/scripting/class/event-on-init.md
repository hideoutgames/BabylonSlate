---
node: flow.event.init
---

# Event On Init

Runs once when the Game Instance, a subsystem or an object made with Create Object is created.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Game Subsystems run it before the Game Instance. A Scene Subsystem runs it when its scene is created, before the scene's actors begin play.
- [Create Object](create-object.md) runs it before it returns the new object.
- Only in Game Instance, Game Subsystem, Scene Subsystem and Object classes.
