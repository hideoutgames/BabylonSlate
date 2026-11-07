# Cameras

A [Camera](../components/camera.md) component is a view the player can see in Play. Every scene also has its own **Layer Camera**, a 2D camera that Play looks through until a camera actor is possessed. The scene's **Default Camera** names the actor Play possesses when the scene starts, scripts can switch cameras, and a [Spring Arm](../components/spring-arm.md) keeps a camera at a distance behind a moving actor.

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

## Choose the camera in view

1. Open the scene and clear the selection so the **Inspector** shows **Scene Settings**.
2. Use **Default Camera** to pick a placed actor. Actors with a Camera component are listed first, under **Camera Actors**. Pick **None** to start on the Layer Camera.

When Play starts, Haptic picks the view in this order:

1. A camera chosen with [Possess Camera](../scripting/class/possess-camera.md) at Begin Play.
2. The scene's **Default Camera**, through its actor's first Camera component.
3. The first camera with **Attempt Possess View Target** on.
4. The scene's [Layer Camera](#layer-camera).

During Play the view returns to the Layer Camera when Possess Camera gets None or an actor without a Camera component, and when the possessed actor is destroyed.

If the Default Camera's actor has no Camera component or has been deleted, the **Default Camera** row says so, and Play starts on the Layer Camera.

## Layer Camera

The Layer Camera is an orthographic camera that looks along +Z at the scene's XY plane, like a [Scene Layer's](../scenes/scene-layers.md#move-the-layer-camera) camera. It suits 2D games, which then need no camera actor.

| Setting | Default | Description |
| --- | --- | --- |
| **Layer Camera Location** | 0, 0 | The point at the centre of the view when the scene starts. |
| **Layer Camera Width**, **Layer Camera Height** | 16, 9 | The area the view frames, in world units. |

- The view keeps the whole Width × Height in view: on a wider or taller screen it shows more around it, never stretching it.
- It draws content up to 500 units in front of and behind the XY plane.
- In the 2D viewport, an orange outline shows the Layer Camera's view, centred on **Layer Camera Location**. It is hidden while the scene starts on a Default Camera actor.
- Scripts can move, turn and zoom it. Each time the scene loads it starts again at **Layer Camera Location**, unturned, at zoom 1.

## Preview the game camera

In the viewport toolbar, turn on **Game Camera** (<kbd>Shift</kbd>+<kbd>C</kbd>). The viewport shows the Default Camera's view, and the button stays highlighted. While it is on, the viewport's look, fly (<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> and the joystick), pan and zoom inputs move the Default Camera's actor instead of the editor camera. Each pause in input saves the new transform as one undoable change. When the Default Camera's actor is locked, has no Camera component, or the scene has none, those inputs do nothing. Turning Game Camera off returns you to your editor view, which is unchanged.

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

## Script the camera

[Get Scene Camera Manager](../scripting/class/get-scene-camera-manager.md) returns the **Scene Camera Manager**. Drag from it for:

| Member | Returns |
| --- | --- |
| **Get Layer Camera** | The current scene's Layer Camera. |
| **Get Camera Actor** | The actor the view looks through, or None while the Layer Camera is in view. |
| **Get Camera Component** | That actor's Camera component in view, or None while the Layer Camera is in view. |

Drag from a **Layer Camera** reference for its members:

| Member | Description |
| --- | --- |
| **Get Camera Location**, **Set Camera Location** | The point at the centre of the view (Vector 2). |
| **Add Camera Offset** | Moves the camera by **Delta** from where it is now. |
| **Get Camera Rotation**, **Set Camera Rotation** | The camera's angle in degrees. Positive turns the camera counter-clockwise, so the content turns clockwise on screen. |
| **Get Camera Zoom**, **Set Camera Zoom** | 1 is the normal size; 2 shows half the view at twice the size. Values below 0.01 are raised to 0.01. |

[Tween Layer Camera Location](../scripting/class/tween-layer-camera-location.md), [Tween Layer Camera Rotation](../scripting/class/tween-layer-camera-rotation.md) and [Tween Layer Camera Zoom](../scripting/class/tween-layer-camera-zoom.md) animate them. A Layer Camera write that is not a finite number keeps the current value. Moving the scene's Layer Camera changes the view only while it is in view.

For a camera actor:

- [Possess Camera](../scripting/class/possess-camera.md) switches the view for the whole game; None returns it to the Layer Camera.
- [Get Field Of View](../scripting/class/get-field-of-view.md) and [Set Field Of View](../scripting/class/set-field-of-view.md) read and change a perspective camera's zoom.
- [Get Orthographic Size](../scripting/class/get-orthographic-size.md) and [Set Orthographic Size](../scripting/class/set-orthographic-size.md) do the same for orthographic cameras.
- Drag from a Camera component reference, such as **Get Camera Component**, for its **Projection Mode**, **Field Of View**, **Orthographic Size**, **Near Clip** and **Far Clip** variables and its **Possess** function.

During Play you can also switch to a selected camera from the Play Inspector. See [Debugging](../debugging/index.md).

For 2D games, see [2D](../2d/index.md). To render a camera's view into a texture, use a [Render Target Capture](render-targets.md).
