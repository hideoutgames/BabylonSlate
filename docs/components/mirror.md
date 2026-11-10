# Mirror

A flat surface that shows the scene reflected from the current camera.

## Add it

Select an actor, then choose **Add Component > Rendering > Mirror**. You can also place a ready-made actor from **Place Actors > Rendering > Mirror**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Shows the mirror. Off hides the surface and stops its reflection. Default on. |
| Reflects | What the mirror draws live: **Everything**, **Moving Actors** or **Environment**. See [Cheaper reflections](#cheaper-reflections). Default Everything. |
| Width | Width along local X, in scene units. Default 2. |
| Height | Height along local Y, in scene units. Default 2. |
| Resolution Scale | Reflection resolution as a fraction of the resolution the view renders at, from 0.1 to 1. With [FSR Upscaling](../graphics/post-processing.md#project-effects) on, that is its lower render resolution. Lower values look softer and save GPU time and memory. Default 1. |
| Tint | Multiplies the reflection on the built-in surface. Default white. |
| Material | A Material for the surface instead of the built-in one. Default none (the built-in surface). |

## How it works

The reflective side faces the actor's local −Z, the same side a Plane mesh shows: a camera looking along the actor's forward direction sees the reflection. Each frame the mirror renders the scene again, mirrored across its plane, from the camera you are looking through, so the reflection follows your view in the editor viewport and in Play.

## Cost

- Each mirror that draws costs about one more render of the scene, mostly main-thread time.
- At most two mirrors draw a new reflection each frame: mirrors that have no reflection yet first, then the ones nearest the camera. Other mirrors keep their last reflection until their turn.
- A mirror the camera can't see, or sees from behind, draws nothing.
- A reflection draws only what can appear on the mirror's surface: objects outside that part of the mirrored view cost nothing, and moving them doesn't make the mirror draw again unless their shadow falls on something it shows.
- While the camera and everything in the reflection stay still, the mirror keeps its reflection instead of drawing it again. Text, sprites and tilemaps keep it too, and animated tiles draw it again only when their frame changes. Animated Materials, skinned meshes and live images such as other captures make it draw again each frame.
- Each mirror keeps its own reflection image in GPU memory. **Resolution Scale** makes it smaller.
- With [Reflection Shadows](../graphics/shadows.md#shadows-in-reflections) on (Ultra), each mirror that draws also renders the directional light's shadow again, fitted to its reflection.

## Cheaper reflections

**Reflects** trades how much of the scene a mirror draws again for how exact its reflection is.

| Reflects | The mirror draws | The rest of the reflection |
| --- | --- | --- |
| Everything | Every opaque surface and the sky. | Nothing: the whole reflection is live. |
| Moving Actors | Only actors that can move: everything a [Reflection Probe](reflection-probe.md#how-it-works) leaves out, such as characters, physics bodies that are not static, and scripted and spawned actors. | The Reflection Probe the mirror stands in, or the scene's [environment lighting](../graphics/lighting.md#environment-lighting) when it stands in none. |
| Environment | Nothing. | The same probe or environment, alone. |

- **Moving Actors** costs a draw for each moving actor the mirror can show, and nothing while it can show none.
- **Environment** costs no extra render of the scene and keeps no reflection image in GPU memory.
- The part that comes from a probe is as sharp as the probe's **Resolution** and is projected onto the probe's box, so it lines up best when that box matches the room. It shows the scene as the probe last captured it.
- A moving actor is drawn in front of everything that comes from the probe, even static scenery that stands between it and the mirror.
- Without a probe or environment lighting, that part shows the scene's background colour.
- **Mirror Reflections** in the **Geometry** group of [Scalability](../graphics/index.md#scalability) caps every mirror at once, so a project can keep full reflections on fast devices and cheaper ones elsewhere. A mirror draws whichever of its own **Reflects** and the cap draws less.

## Custom surfaces

Assign a Material with a [**Mirror Reflection**](../scripting/material/mirror-reflection.md) node to give the surface its own look, such as a ripple, frosted edges or a dirty tint. The node reads the reflection at each point of the surface, and its **Offset** input distorts it. **Tint** applies only to the built-in surface. With **Reflects** set to Moving Actors or Environment, the node returns the same combined image the built-in surface shows; **Offset** moves only the live part.

## Notes

- World scenes only.
- Actor and component scale also change the size.
- Mirrors reflect opaque surfaces and the sky. Transparent surfaces, particles, water and other mirrors don't appear in the reflection.
- No reflection is drawn for orthographic cameras; the surface keeps its last reflection, or shows black before its first. A mirror that does not reflect everything shows its probe or environment instead of black.
- Render Target Captures that see a mirror show the reflection drawn for the main camera.
- Reflection Probes don't capture mirrors.
- Reflections show point and spot light shadows. They show the directional light's shadow only with [Reflection Shadows](../graphics/shadows.md#shadows-in-reflections) on, which Ultra quality does; otherwise the directional light lights them as if nothing blocked it.
- A mirror never casts shadows.

## Related

- [Render targets](../graphics/render-targets.md)
- [Water](../graphics/water.md) for reflective water surfaces
