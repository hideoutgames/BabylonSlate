# 2D Anchor

Anchors a Scene Layer actor to a point on the layer and offsets it from its placed position.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Anchor**. You can also place a ready-made helper from **Place Actors > Overlay > 2D Anchor**.

## Settings

| Setting | Description |
| --- | --- |
| Anchor | The layer point the actor is anchored to: Top Left, Top Center, Top Right, Center Left, Center, Center Right, Bottom Left, Bottom Center or Bottom Right. Default Center. |
| Offset X | Shifts the actor sideways from its placed position, in layer units. Default 0. |
| Offset Y | Shifts the actor up (positive) or down from its placed position, in layer units. Default 0. |

## Notes

- Scene Layers only.
- Layer units are the units of **Layer Width** and **Layer Height** in the Scene Layer's settings.
- An actor that holds only a 2D Anchor is an anchor helper. It has no position of its own, no Transform and no visual, and it anchors its parent actor. A helper with no parent does nothing.
- When an actor and one of its ancestors both have an anchor, the topmost anchor applies and the rest of the branch follows it.
- Animate the offset with [Tween Anchor Offset](../scripting/class/tween-anchor-offset.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Scene Layer](../assets/scene-layer.md)
