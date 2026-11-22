# Sound Attenuation

How a sound fades with distance from the listener. Giving an Audio asset a Sound Attenuation makes it 3D.

## Create

In the **Content Browser**, choose **New Asset > Audio > Sound Attenuation**. Then set **Routing > Sound Attenuation** on an [Audio](audio.md) asset. One attenuation can serve many sounds.

## Editor

Double-tap the asset to open it. The window has an **Inspector** only. A plot at the top shows the volume at each distance, from the emitter to a little past **Max Radius**, with faint lines at both radii. Where the volume jumps, at a radius, the plot draws the step.

## Settings

| Setting | Description |
| --- | --- |
| Inner Radius | Within this distance the sound plays at full volume. Default 10. |
| Max Radius | Beyond this distance the sound is silent. Default 250. |
| Falloff | How the volume falls between the two radii: **Natural** (default), **Linear**, **Inverse**, **Exponential** or **Custom**. See [Falloff](#falloff). |
| Falloff Curve | Custom only. The [Float Curve](curve.md) the volume follows. |
| Spatialisation | **Equal Power** (default) or **HRTF**, which works best on headphones. |
| Cone | Makes the sound directional. Off by default. |
| Inner Angle, Outer Angle, Outer Gain | Cone only. Defaults 90, 120 and 0. |
| Doppler | Shifts pitch as the sound moves towards or away from the listener. Off by default. |
| Doppler Factor | Doppler only. Strength of the effect. Default 1. |

Distances are in world units. **Inner Radius** cannot pass **Max Radius**: dragging one past the other stops at it. With both equal, the sound plays at full volume up to that distance and is silent beyond it.

## Falloff

Every falloff is a curve: across from 0 at **Inner Radius** to 1 at **Max Radius**, up from silent (0) to full volume (1).

| Falloff | Shape |
| --- | --- |
| Natural | Stays close to full volume just outside **Inner Radius**, falls through the middle and fades gently into silence at **Max Radius**, so neither edge is heard. |
| Linear | A straight line from full volume to silence. |
| Inverse | Falls quickly near the sound and slowly far from it, like real sound, reaching silence at **Max Radius**. |
| Exponential | Between Linear and Inverse. |
| Custom | Follows the **Falloff Curve** you pick. |

With **Custom**:

- Only the part of the curve from 0 to 1 across is used, and values below 0 or above 1 play as 0 or 1.
- Within **Inner Radius** the sound is always at full volume, and beyond **Max Radius** always silent. A curve that does not start at 1 jumps there at **Inner Radius**; one that ends above 0 cuts off at **Max Radius**.
- Without a curve, or when the picked curve is missing, the sound falls off as **Natural**. The row says so, and Play logs a warning.
- The plot follows the curve as you edit it, before you save.

To start a curve from a built-in falloff, choose that falloff and tap **Create Curve From** it (for example **Create Curve From Natural**) under the settings. It makes a Float Curve with the same keys in the attenuation's folder, switches **Falloff** to **Custom** with that curve and opens it.

## Related

- [Spatial Audio](../audio/spatial-audio.md)
- [Audio component](../components/audio.md)
- [Curve](curve.md)
