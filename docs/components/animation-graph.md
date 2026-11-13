# Animation Graph

Plays an Animation Graph on an actor: a state machine that drives Model animations and Sprite Animations.

## Add it

Select an actor, then choose **Add Component > Animation > Animation Graph**.

## Settings

| Setting | Description |
| --- | --- |
| Animation Graph | The [3D or 2D Animation Graph](../assets/animation-graph.md) to run. When a 3D graph's Skeleton differs from the one the actor's Model is on, the row says so: the graph's Animations will not play on that Model. |

## Notes

- Works in world scenes and in Scene Layers.
- The actor needs something to animate: a [Mesh](mesh.md) whose Model is on the 3D graph's Skeleton, or a [Sprite](sprite.md) for a 2D graph.
- An actor can have several Animation Graph components. If two play at once, the last one in the component list wins.
- Scripts reach a graph through the component. [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md), [Get Anim Graph Variable](../scripting/class/get-anim-graph-variable.md), [Get Current State](../scripting/class/get-current-state.md) and [Jump To State](../scripting/class/jump-to-state.md) take this component as their target. An unconnected target does nothing.
- A jump takes effect on the next animation update.

## Related

- [Models](../graphics/models.md)
- [Sprites](../2d/sprites.md)
- [Animation Graph](../assets/animation-graph.md)
