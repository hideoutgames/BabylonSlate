# Audio Channel

A group that sounds play through, such as Music, Effects or Voice, with optional reverb and wall muffling.

## Create

In the **Content Browser**, choose **New Asset > Audio > Audio Channel**. To use it, set **Routing > Audio Channel** on an [Audio](audio.md) asset. To control its volume, list it on an [Audio Mixer](audio-mixer.md).

## Editor

Double-tap the asset to open it. The window has an **Inspector** only.

## Settings

| Setting | Description |
| --- | --- |
| Parent Channel | Another channel this one sits under. A channel's volume is multiplied by its parents' volumes. None by default. |
| Environment Reverb | Gives the channel's sounds the echo of the space around the listener. Off by default. |
| Muffle Through Walls | Muffles 3D sounds when static geometry lies between the sound and the listener. Off by default. |

A channel has no volume of its own. Set it on the mixer.

## Related

- [Mixing](../audio/mixing.md)
- [Audio Mixer](audio-mixer.md)
- [Sound Attenuation](sound-attenuation.md)
