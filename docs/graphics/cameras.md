# Cameras

A [Camera](../components/camera.md) component is the view the player sees in Play. Each scene names one **Default Camera**, scripts can switch cameras, and a [Spring Arm](../components/spring-arm.md) keeps a camera at a distance behind a moving actor.

## Add a camera

- Open **Place Actors > Camera > Camera**, or add a **Camera** component with **Add Component > Camera**.
- A camera looks along its actor's forward (+Z) axis. Move and rotate the actor to frame the shot.
- Select a camera to see its view frustum and a small preview of its view in the corner of the viewport.

New scenes already contain a **Camera** actor set as the Default Camera.

## Camera settings

| Setting | Default | Description |
| --- | --- | --- |
| **Projection Mode** | Perspective | **Perspective** or **Orthographic**. Cameras in 2D scenes start orthographic. |
| **Field Of View** | 60 | Perspective only. Vertical angle in degrees, 1 to 179. |
| **Orthographic Size** | 5 | Orthographic only. Half the view height, in world units. |
| **Near Clip**, **Far Clip** | 0.1, 1000 | Nothing closer than Near Clip or farther than Far Clip is drawn. Near must be less than Far. |
| **Attempt Possess View Target** | Off | Use this camera when Play starts if the scene has no Default Camera. |

The view's width follows the screen's aspect ratio. To fix the aspect for Play, see [Resolution and frame rate](index.md#resolution-and-frame-rate).

## Choose the Default Camera

1. Open the scene and clear the selection so the **Inspector** shows **Scene Settings**.
2. Use **Default Camera** to pick a Camera component in the scene.

When Play starts, Haptic picks the active camera in this order:

1. A camera chosen with [Possess Camera](../scripting/class/possess-camera.md) at Begin Play.
2. The scene's **Default Camera**.
3. The first camera with **Attempt Possess View Target** on.
4. A default Play camera.

If you delete the Default Camera's actor, pick a new one.

## Preview the game camera

In the viewport, open **Viewport Settings** and turn on **Game Camera** (<kbd>Shift</kbd>+<kbd>C</kbd>). The viewport shows the Default Camera's view and a **Game Camera** badge. Editor navigation is paused until you turn it off, and your editor view is kept.

## Follow an actor with a Spring Arm

A Spring Arm holds its child components at **Arm Length** behind its origin, along its local −Z axis. A child Camera at the end of the arm looks back at the arm's origin.

1. Open the actor's Class or Prefab.
2. In **Components**, add a **Spring Arm**.
3. Select the Spring Arm and add a **Camera**. It is added as a child of the arm. You can also drag existing components onto the arm.
4. Rotate the Spring Arm to set the viewing angle.

| Setting | Default | Description |
| --- | --- | --- |
| **Arm Length** | 4 | Distance from the arm's origin to its children, 0 to 1000. |
| **Enable Location Lag**, **Location Lag Speed** | Off, 10 | During Play, the arm trails its target position. Higher speeds catch up faster. |
| **Max Location Lag Distance** | 0 | Furthest the arm may trail. 0 means unlimited. |
| **Enable Rotation Lag**, **Rotation Lag Speed** | Off, 10 | During Play, the arm eases toward its target rotation. |
| **Draw Debug Lag** | Off | During Play, draws the target arm (yellow), the lagged arm (green) and the lag offset (red). |

Lag is frame-rate independent. Only child components follow the arm; child actors do not. The Spring Arm does not collide with walls.

## Cameras in scripts

- [Possess Camera](../scripting/class/possess-camera.md) switches the active camera for the whole game.
- [Get Field Of View](../scripting/class/get-field-of-view.md) and [Set Field Of View](../scripting/class/set-field-of-view.md) read and change a perspective camera's zoom.
- [Get Orthographic Size](../scripting/class/get-orthographic-size.md) and [Set Orthographic Size](../scripting/class/set-orthographic-size.md) do the same for orthographic cameras.

During Play you can also switch to a selected camera from the Play Inspector. See [Debugging](../debugging/index.md).

For 2D games, see [2D](../2d/index.md). To render a camera's view into a texture, use a [Render Target Capture](render-targets.md).
