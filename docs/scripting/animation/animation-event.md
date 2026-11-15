---
node: anim.event.notify
---

# Animation Event

Runs when this Animation Graph fires the Animation Event it is named after, such as **Event Footstep**.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec | Runs each time the event fires. |

## Notes

- Only available in the Animation Object graph of an Animation Graph asset. **Add Node** lists one **Event** node per Animation Event the graph can fire: those on the [Animations](../../assets/animation.md#animation-events) on its Skeleton (2D: on its [Sprite Animations' frames](../../assets/sprite-animation.md#animation-events)) and its states' **Enter Event**, **Exit Event** and **Fully Blended Event**.
- An event name is shared: every Animation with an event of that name runs the same node. The node runs only when this graph fires the event, never another graph's.
- A window (an event with a **Duration**) has **Begin** and **End** instead of **Out**. End always follows Begin, even when the animation stops before reaching it.
- A clip fires its events only while it plays at or above each event's **Trigger Weight**, so an animation fading out of a blend does not repeat a footstep. See [Animation Events](../../assets/animation-graph.md#animation-events).
- An event's **Action** (Play Sound, Spawn Particle System) runs before this node, and without it.
