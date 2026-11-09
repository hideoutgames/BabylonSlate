# Spring Arm

Holds its child components at the end of an arm, with optional lag, so a camera can follow an actor smoothly.

## Add it

Open the actor's Class or Prefab. In **Components**, choose **Add Component > Camera > Spring Arm**, then add a [Camera](camera.md) as its child. Rotate the Spring Arm to set the viewing angle.

## Settings

| Setting | Description |
| --- | --- |
| Arm Length | Distance behind the arm's origin, along its local -Z axis, where children attach. 0 to 1000. Default 4. |
| Enable Location Lag | In Play, the arm trails behind its target position. Default off. |
| Location Lag Speed | How fast the arm catches up, 0.1 to 100. Default 10. |
| Max Location Lag Distance | Furthest the arm may trail. 0 means unlimited. Default 0. |
| Enable Rotation Lag | In Play, the arm eases toward its target rotation. Default off. |
| Rotation Lag Speed | How fast the rotation catches up, 0.1 to 100. Default 10. |
| Draw Debug Lag | In Play, draws the target arm (yellow), the lagged arm (green) and the lag offset (red). Default off. |
| Camera Probe | In Play, shortens the arm in front of anything that blocks it, so the camera never ends up inside a wall. Default off. |
| Probe Size | Radius of the probe sphere: how far the camera stays from what blocks it. 0.01 to 5. Default 0.15. |
| Probe Channel | What blocks the probe: **Static** (walls, floors, Mesh collision and Blocking Volumes), **Dynamic**, **Character** or **Solid** (everything). See [Collision channels](../physics/collision.md#collision-channels). Default **Static**. |
| Probe Return Speed | How fast the arm grows back once the way clears, 0 to 100. 0 returns at once. Default 10. |

## Notes

- World scenes only.
- Only child components follow the arm. Child actors do not.
- The lag does not depend on the frame rate.
- With **Camera Probe** on, each frame in Play a small sphere travels from the arm's origin toward the end of the arm, and children attach where it first touches something. The arm pulls in at once, so the camera never passes through a wall, and eases back out at **Probe Return Speed**.
- The probe ignores triggers, the arm's own actor and the actors it is attached to.
- The probe follows the arm's target position. With lag on, a lagging camera can briefly pass closer to a wall than **Probe Size**.
- In the editor viewport the arm keeps its full length.

## Related

- [Cameras](../graphics/cameras.md)
