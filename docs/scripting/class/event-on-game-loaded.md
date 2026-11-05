---
node: flow.event.gameLoaded
---

# Event On Game Loaded

Runs after Load Game restores saved world state and references, before gameplay continues.

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Runs only on the Game Instance and Game Subsystems. Actors, components, the Scene, Scene Subsystems, Scene Layers and Scene Layer Actors do not get it.
- To let an actor react to a load, declare an [Event Dispatcher](../event-dispatchers.md) on the Game Instance, call it from this event, and bind the actor's event to it.
- A graph of any other class that still has this event shows an error in **Compiler Results**.
- Not available in function graphs.
