# Animation Graph

Plays an Animation Graph on an actor: its State Machine and state graphs drive Model animations and Sprite Animations.

## Add it

Select an actor, then choose **Add Component > Animation > Animation Graph**.

## Settings

| Setting | Description |
| --- | --- |
| Animation Graph | The [3D or 2D Animation Graph](../assets/animation-graph.md) to run. When a 3D graph's Skeleton differs from the one the actor's Model is on, the row says so: the graph's Animations will not play on that Model. |
| Tick Mode | When the graph runs. **Always** (the default) runs it and poses the actor every frame. **When Visible** runs it every frame but poses the actor only while a camera can see it or its shadow, which saves time with many characters out of view. **Never** stops the graph: the actor holds its pose and no Animation Events fire. |

## Notes

- Works in world scenes and in Scene Layers.
- The actor needs something to animate: a [Mesh](mesh.md) whose Model is on the 3D graph's Skeleton, or a [Sprite](sprite.md) for a 2D graph.
- An actor can have several Animation Graph components. If two play at once, the last one in the component list wins.
- Scripts reach a graph through the component. [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md), [Get Anim Graph Variable](../scripting/class/get-anim-graph-variable.md), [Get Current State](../scripting/class/get-current-state.md) and [Jump To State](../scripting/class/jump-to-state.md) take this component as their target. An unconnected target does nothing.
- A jump takes effect on the next animation update.
- Scripts read and change **Tick Mode** with [Get Animation Tick Mode](../scripting/class/get-animation-tick-mode.md) and [Set Animation Tick Mode](../scripting/class/set-animation-tick-mode.md).
- With **When Visible**, an actor out of view keeps the last pose it showed: an actor attached to one of its bones follows that pose until it comes back into view.

## Related

- [Models](../graphics/models.md)
- [Sprites](../2d/sprites.md)
- [Animation Graph](../assets/animation-graph.md)
