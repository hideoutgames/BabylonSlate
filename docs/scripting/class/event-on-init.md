---
node: flow.event.init
---

# Event On Init

Runs once when the Game Instance or a subsystem is created.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Game Subsystems run it before the Game Instance. A Scene Subsystem runs it when its scene is created, before the scene's actors begin play.
- Only in Game Instance, Game Subsystem and Scene Subsystem classes.
