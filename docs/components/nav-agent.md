# Nav Agent

Lets an actor find and follow paths across the baked NavMesh.

## Add it

Select an actor, then choose **Add Component > AI > Nav Agent**. The scene needs a baked [NavMesh](nav-mesh.md).

## Settings

| Setting | Description |
| --- | --- |
| Radius | Agent radius in world units. Minimum 0.05. Default 0.5. |
| Height | Agent height in world units. Minimum 0.1. Default 2. |
| Max Speed | Top walking speed, in units per second. Default 3.5. |
| Max Acceleration | How quickly it reaches that speed. Default 8. |

## Notes

- Works in world scenes and in Scene Layers.
- Give it a destination with [Move To](../scripting/class/move-to.md) and stop it with [Stop Movement](../scripting/class/stop-movement.md). A [Behaviour Tree](behaviour-tree.md) can do the same with its Move To tasks.
- The agent faces the direction it moves.
- A scene supports up to 128 agents at once.
- An actor with a Dynamic [Rigid Body](rigid-body.md) in a 3D scene stays under physics. Navigation steers it along the ground and gravity still applies.
- Do not combine it with [Movement](movement.md) on one actor.

## Related

- [Navigation](../ai/navigation.md)
- [Find Path To](../scripting/class/find-path-to.md)
