# Audio

A sound: one or more clips with volume, pitch and routing settings.

## Import

Audio assets are not created from **New Asset**. In the **Content Browser**, choose **Import** and pick a WAV, MP3 or OGG file. Haptic keeps the file in its original format. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview**, **Inspector** and **Clips**.

- **Preview** has **Play** and **Stop**, a **Loop** toggle and the waveform. While a clip plays, a playhead with the elapsed time moves across the waveform. Preview is never 3D.
- **Clips** lists the asset's sound files. **Add Clip** imports another WAV, MP3 or OGG file, up to 8 clips. Each play picks one clip at random by its **Weight**; a percentage shows each clip's share. The first clip cannot be removed.
- The **Inspector** has **Playback** and **Routing**.

## Settings

| Setting | Description |
| --- | --- |
| Volume | Level from 0 to 1. Default 1. |
| Loop | Repeats the sound until it is stopped. Off by default. |
| Randomize Pitch | Picks a pitch between **Pitch Min** and **Pitch Max** each time the sound plays. |
| Pitch | A fixed pitch from 0.25 to 4. Shown when Randomize Pitch is off. Default 1. |
| Pitch Min, Pitch Max | The random range, from 0.25 to 4. Shown when Randomize Pitch is on. |
| Audio Channel | The [Audio Channel](audio-channel.md) the sound plays through. None by default. |
| Sound Attenuation | A [Sound Attenuation](sound-attenuation.md) asset that makes the sound 3D. None plays it at full volume everywhere. |

## Related

- [Audio](../audio/index.md)
- [Audio component](../components/audio.md)
- [Play Sound](../scripting/class/play-sound.md)
