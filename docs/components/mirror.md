# Mirror

A flat surface that shows the scene reflected from the current camera.

## Add it

Select an actor, then choose **Add Component > Rendering > Mirror**. You can also place a ready-made actor from **Place Actors > Rendering > Mirror**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Shows the mirror. Off hides the surface and stops its reflection. Default on. |
| Width | Width along local X, in scene units. Default 2. |
| Height | Height along local Y, in scene units. Default 2. |
| Resolution Scale | Reflection resolution as a fraction of the view's, from 0.1 to 1. Lower values look softer and save GPU time and memory. Default 1. |
| Tint | Multiplies the reflection on the built-in surface. Default white. |
| Material | A Material for the surface instead of the built-in one. Default none (the built-in surface). |

## How it works

The reflective side faces the actor's local −Z, the same side a Plane mesh shows: a camera looking along the actor's forward direction sees the reflection. Each frame the mirror renders the scene again, mirrored across its plane, from the camera you are looking through, so the reflection follows your view in the editor viewport and in Play.

## Cost

- Each mirror that draws costs about one more render of the scene, mostly main-thread time.
- At most two mirrors draw a new reflection each frame: mirrors that have no reflection yet first, then the ones nearest the camera. Other mirrors keep their last reflection until their turn.
- A mirror the camera can't see, or sees from behind, draws nothing.
- Each mirror keeps its own reflection image in GPU memory. **Resolution Scale** makes it smaller.

## Custom surfaces

Assign a Material with a [**Mirror Reflection**](../scripting/material/mirror-reflection.md) node to give the surface its own look, such as a ripple, frosted edges or a dirty tint. The node reads the reflection at each point of the surface, and its **Offset** input distorts it. **Tint** applies only to the built-in surface.

## Notes

- World scenes only.
- Actor and component scale also change the size.
- Mirrors reflect opaque surfaces and the sky. Transparent surfaces, particles, water and other mirrors don't appear in the reflection.
- No reflection is drawn for orthographic cameras or under **Clustered Forward** lighting; the surface keeps its last reflection, or shows black before its first.
- Render Target Captures that see a mirror show the reflection drawn for the main camera.
- A mirror never casts shadows.

## Related

- [Render targets](../graphics/render-targets.md)
- [Water](../graphics/water.md) for reflective water surfaces
