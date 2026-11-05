---
node: flow.event.scalabilityChanged
---

# Event Scalability Changed

Runs when the renderer confirms or rejects the latest quality request.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Settings | ScalabilitySnapshot | The requested and effective rendering settings, and the result of the request. |

## Notes

- Read **Settings** for the result and the settings now in effect.
- Results for a request that a newer one has replaced are ignored.
- Runs on the Game Instance, Game Subsystems, Scene Layers (in their [Scene Layer Script](../scene-scripts.md)) and Scene Layer Actors. Other actors, components, the Scene and Scene Subsystems do not get it.
- To let another object react, declare an [Event Dispatcher](../event-dispatchers.md) on the Game Instance, call it from this event, and bind that object's event to it.
- A graph of any other class that still has this event shows an error in **Compiler Results**.
- Not available in function graphs.
