# Camera

The view the player sees in Play: a perspective or orthographic camera attached to an actor.

## Add it

Select an actor, then choose **Add Component > Camera > Camera**. You can also place a ready-made actor from **Place Actors > Camera > Camera**.

## Settings

| Setting | Description |
| --- | --- |
| Projection Mode | **Perspective** or **Orthographic**. Cameras added in 2D scenes start orthographic. |
| Field Of View | Perspective only. Vertical angle in degrees, 1 to 179. Default 60. |
| Orthographic Size | Orthographic only. Half the view height in world units, 0.1 to 50. Default 5. |
| Near Clip | Nothing closer is drawn. Default 0.1. Must be less than Far Clip. |
| Far Clip | Nothing farther is drawn. Default 1000. Must be greater than Near Clip. |
| Attempt Possess View Target | Uses this camera when Play starts if the scene has no Default Camera. Default off. |

## Notes

- World scenes only.
- A camera looks along its actor's forward (+Z) axis.
- Choose the Default Camera in **Scene Settings**, with nothing selected in the **Inspector**.
- To follow an actor, put the camera on a [Spring Arm](spring-arm.md).
- In scripts, [Possess Camera](../scripting/class/possess-camera.md) switches the active camera. [Set Field Of View](../scripting/class/set-field-of-view.md) and [Set Orthographic Size](../scripting/class/set-orthographic-size.md) change the zoom.

## Related

- [Cameras](../graphics/cameras.md)
- [Render Target Capture](render-target-capture.md)
- [2D](../2d/index.md)
