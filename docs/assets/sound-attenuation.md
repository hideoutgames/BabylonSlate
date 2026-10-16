# Sound Attenuation

How a sound fades with distance from the listener. Giving an Audio asset a Sound Attenuation makes it 3D.

## Create

In the **Content Browser**, choose **New Asset > Audio > Sound Attenuation**. Then set **Routing > Sound Attenuation** on an [Audio](audio.md) asset. One attenuation can serve many sounds.

## Editor

Double-tap the asset to open it. The window has an **Inspector** only. A plot at the top shows how volume falls with distance.

## Settings

| Setting | Description |
| --- | --- |
| Inner Radius | Within this distance the sound plays at full volume. Default 10. |
| Max Radius | Beyond this distance the sound is silent. Default 250. |
| Distance Model | **Linear** (default), **Inverse** or **Exponential**. |
| Rolloff | How steeply volume falls with Inverse and Exponential. Default 1. |
| Spatialisation | **Equal Power** (default) or **HRTF**, which works best on headphones. |
| Cone | Makes the sound directional. Off by default. |
| Inner Angle, Outer Angle, Outer Gain | Cone only. Defaults 90, 120 and 0. |
| Doppler | Shifts pitch as the sound moves towards or away from the listener. Off by default. |
| Doppler Factor | Doppler only. Strength of the effect. Default 1. |

Distances are in world units.

## Related

- [Spatial Audio](../audio/spatial-audio.md)
- [Audio component](../components/audio.md)
