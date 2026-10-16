# Mixing

Group sounds into channels, control their volume from one mixer, and add room reverb and wall muffling.

## How mixing works

- An **Audio Channel** is a group that sounds play through, such as Music, Effects or Voice. Channels can have a parent, so Footsteps can sit under Effects.
- An **Audio Mixer** holds a **Global Volume** and a volume for each channel.
- The project uses one mixer, chosen in **Project Settings > Audio > Audio Mixer**.

A sound's final volume is its asset **Volume** × its play volume × its channel's volume × each parent channel's volume × the mixer's **Global Volume**. Every factor runs from 0 to 1.

Mixers and channels are optional. With **Audio Mixer** set to None, sounds play at their asset and play volume only.

## Set up channels and a mixer

1. In the **Content Browser**, choose **New Asset > Audio > Audio Channel** for each group you need. Set a **Parent Channel** if the group belongs to another.
2. Choose **New Asset > Audio > Audio Mixer** and open it.
3. Tap **Add Channel** and pick a channel. Set its **Volume**. Repeat for each channel. Each channel can appear only once.
4. Open **Project Settings > Audio** and set **Audio Mixer** to your mixer.
5. Open each Audio asset and set **Routing > Audio Channel**.

A channel has no volume of its own: its volume comes from the mixer. A mixer with no channels still applies its **Global Volume**.

## Change volume while the game runs

| Node or command | Effect |
| --- | --- |
| [Set Channel Volume](../scripting/class/set-channel-volume.md) | Sets one channel's volume. The channel must be listed on the project's mixer. |
| [Set Global Volume](../scripting/class/set-global-volume.md) | Sets the mixer's Global Volume. |
| `volume` | The same as Set Global Volume, from the [console](../debugging/console.md). |

Changes apply at once to sounds already playing. They last for the session only and never edit the assets, so a volume menu should store the player's choice in a save game and apply it at start.

## Reverb

Turn on **Environment Reverb** on an Audio Channel to give its sounds the echo of the space around the listener. Haptic works out the reverb from the static meshes in the scene and stores it with the scene when you save. Sounds without a channel stay dry.

**Project Settings > Audio** scales the effect for the whole project:

| Setting | Description |
| --- | --- |
| Reverb Wet Scale | How much reverb is heard. 0 to 2, default 1. |
| Reverb Decay Scale | How long the reverb lasts. 0 to 2, default 1. |
| Reverb Damping Scale | How quickly high frequencies fade from the reverb. 0 to 2, default 1. |

## Muffle through walls

Turn on **Muffle Through Walls** on an Audio Channel to muffle 3D sounds when static geometry lies between the sound and the listener. It uses the same scene data as reverb and only affects sounds with a [Sound Attenuation](spatial-audio.md).

Turn off **Occlusion** in **Project Settings > Audio** to disable muffling for the whole project.

## Related

- [Audio Mixer](../assets/audio-mixer.md)
- [Audio Channel](../assets/audio-channel.md)
- [Audio](index.md)
