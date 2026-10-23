# Reflection Probe

Captures the static scene around a point so surfaces inside its box reflect their real surroundings instead of the sky.

## Add it

Select an actor, then choose **Add Component > Rendering > Reflection Probe**. You can also place a ready-made actor from **Place Actors > Environment > Reflection Probe**. Put it near the middle of a room and fit its **Size** to the room.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the probe on or off. Default on. |
| Size | Full width, height and depth of the probe's box, in scene units. Default 10, 10, 10. |
| Resolution | Size of each captured face: 64, 128 or 256 pixels. Larger is sharper and takes longer to capture. Default 128. |

## How it works

- Each surface reflects the probe whose box contains its centre. Where boxes overlap, the smallest one wins; outside every box, surfaces reflect the scene's [environment lighting](../graphics/lighting.md#environment-lighting).
- Reflections are projected onto the box, so they line up with walls and floors that match it.
- A probe captures only static actors: plain actors without scripts whose components never move, such as Meshes, Landscapes, Foliage, 3D Text and the Skybox. Characters, physics bodies that are not static, animated, scripted and spawned actors, particles and Water are left out. [Real-Time Reflections](../graphics/post-processing.md) still show them.
- In the editor, probes recapture shortly after you stop editing. In Play and exported games they capture once the scene has loaded; call [Recapture Reflection Probes](../scripting/class/recapture-reflection-probes.md) after moving static scenery.
- The editor shows the box and a small mirror ball at its centre that reflects the latest capture.

## Notes

- World scenes only.
- Actor and component scale change the size. The box stays aligned with the world axes; rotation is ignored.
- Instanced copies of a mesh reflect the probe around the first copy.
- Static actors of streamed scenes are not captured.

## Related

- [Lighting](../graphics/lighting.md#reflection-probes)
- [Post-processing](../graphics/post-processing.md)
