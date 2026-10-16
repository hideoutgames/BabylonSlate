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

## Notes

- World scenes only.
- Only child components follow the arm. Child actors do not.
- The lag does not depend on the frame rate.
- The arm does not push the camera in front of walls.

## Related

- [Cameras](../graphics/cameras.md)
