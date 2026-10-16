# Spatial Audio

Sound Attenuation makes a sound come from a place in the world, getting quieter with distance from the listener.

## Make a sound 3D

1. In the **Content Browser**, choose **New Asset > Audio > Sound Attenuation** and open it.
2. Set **Inner Radius** and **Max Radius**. The plot at the top shows how volume falls with distance.
3. Open an Audio asset and set **Routing > Sound Attenuation** to the new asset.

Every sound that uses this Audio asset is now spatial. One Sound Attenuation asset can serve many sounds.

## Where sound comes from and where it is heard

- The **listener** is the active camera: the possessed camera, otherwise the scene's main camera.
- A sound from an **Audio** component plays at its actor and follows it as it moves.
- [Play Sound](../scripting/class/play-sound.md) plays at the actor running the graph.
- Select an actor with an Audio component to see its range in the viewport: a green sphere for **Inner Radius** and a yellow sphere for **Max Radius**.

Previewing in the Audio asset editor is never spatial.

## Settings

| Setting | Description |
| --- | --- |
| Inner Radius | Within this distance the sound plays at full volume. Default 10. |
| Max Radius | Beyond this distance the sound is silent. Default 250. |
| Distance Model | How volume falls between the two radii: **Linear** (default), **Inverse** or **Exponential**. |
| Rolloff | How steeply volume falls with the Inverse and Exponential models. Default 1. |
| Spatialisation | **Equal Power** (default) pans between left and right. **HRTF** models how sound reaches each ear, which works best on headphones. |
| Cone | Makes the sound directional, aimed by the actor's rotation. |
| Inner Angle, Outer Angle | Cone only. Full volume inside the inner angle, fading to **Outer Gain** at the outer angle, in degrees. Defaults 90 and 120. |
| Outer Gain | Cone only. Volume outside the outer angle, from 0 to 1. Default 0. |
| Doppler | Raises the pitch of sounds moving towards the listener and lowers it as they move away. |
| Doppler Factor | Doppler only. Strength of the effect. Default 1. |

## Gotchas

- Distances are in world units, and actor scale does not change them.
- A spatial sound with no actor to play from plays without position, and a warning is logged.
- To muffle sounds behind walls, enable **Muffle Through Walls** on their channel. See [Mixing](mixing.md).

## Related

- [Sound Attenuation](../assets/sound-attenuation.md)
- [Audio component](../components/audio.md)
- [Cameras](../graphics/cameras.md)
