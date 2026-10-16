---
node: flow.event.beginPlay
---

# Event Begin Play

Runs once when an actor or one of its components starts playing.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Placed actors run it when the scene starts; spawned actors run it as they appear.
- Not available in Game Instance or subsystem classes; use [**Event On Init**](event-on-init.md) there.
