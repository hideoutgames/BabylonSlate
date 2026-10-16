# Audio

Import sounds, play them from actors and scripts, and route them through channels and 3D space.

Sounds are **Audio** assets. You get one by importing a WAV, MP3 or OGG file into the **Content Browser**; **New Asset** does not create sounds. Mixers, channels and attenuation are optional assets you add when a project needs them.

## Edit an Audio asset

Double-tap an Audio asset to open it.

- **Preview** plays the sound and shows its waveform. Toggle **Loop** to preview looping.
- The **Inspector** holds **Playback** and **Routing**.
- **Clips** lists the asset's sound files. **Add Clip** imports another WAV, MP3 or OGG file, up to 8 clips. Each play picks one clip at random by **Weight**, so footsteps and impacts vary.

| Setting | Description |
| --- | --- |
| Volume | Level from 0 to 1. Default 1. |
| Loop | Repeats the sound until it is stopped. Off by default. |
| Randomize Pitch | Picks a pitch between **Pitch Min** and **Pitch Max** each time the sound plays. |
| Pitch | Fixed pitch when Randomize Pitch is off, from 0.25 to 4. Default 1. |
| Audio Channel | The channel the sound plays through. See [Mixing](mixing.md). |
| Sound Attenuation | Makes the sound 3D. See [Spatial Audio](spatial-audio.md). None plays it at full volume everywhere. |

## Play a sound in a scene

Open **Place Actors** and choose your Audio asset under **Project**. Haptic creates an actor with an **Audio** component set to that asset. You can also start from **Place Actors > Audio > Audio**, or **Add Component > Audio > Audio** on an existing actor, then pick the asset.

| Setting | Description |
| --- | --- |
| Audio | The Audio asset to play. |
| Play On Start | Plays the sound when the actor starts. On by default. |
| Loop | Loops the sound even if the asset's own **Loop** is off. |
| Volume | Level from 0 to 1, multiplied with the asset's volume. |

## Play sounds from scripts

- [Play Sound](../scripting/class/play-sound.md) plays an Audio asset from the actor running the graph.
- An Audio component has **Play** and **Stop** functions and **Volume**, **Loop** and **Audio** variables. Setting **Volume** changes a sound that is already playing.
- [Event On Audio Finished](../scripting/class/event-on-audio-finished.md) runs when an Audio component's sound ends. Looping sounds never finish.
- In a Behaviour Tree, the [Play Sound](../scripting/behaviour-tree/play-sound.md) task plays a sound for the actor.

::: tip
To play a looping asset once, turn off **Loop** on the asset. **Play Sound** always follows the asset's Loop setting.
:::

## When sound starts

Browsers keep audio silent until the player interacts with the page. During Play, the game view shows **Click the game view to enable audio** while sounds are waiting. Click or tap the view and queued sounds start. Exported games also wait for the first click or tap.

Pausing Play also pauses its sounds.

## Audio budget

**Engine Settings > Assets** limits how much audio the editor keeps loaded during Play:

| Setting | Description |
| --- | --- |
| Audio Memory Budget | Releases unused clips when audio memory reaches the budget. On by default. |
| Audio Budget (MB) | The budget, from 32 to 2048 MB. Default 256. |
| Max Concurrent Voices | How many sounds can play at once, from 8 to 128. Default 32. The oldest sound stops when the limit is reached. |

To see what is playing, type `showaudiodebug` in the Play [console](../debugging/console.md).

## In this section

- [Mixing](mixing.md): Audio Mixer, Audio Channels, volume control and reverb.
- [Spatial Audio](spatial-audio.md): Sound Attenuation and 3D sound.
