---
node: flow.event.end
---

# Event On End

Runs once when the Game Instance or a subsystem shuts down.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The Game Instance runs it when Play ends, followed by Game Subsystems in reverse order. A Scene Subsystem runs it when its scene is removed.
- Only in Game Instance, Game Subsystem and Scene Subsystem classes.
