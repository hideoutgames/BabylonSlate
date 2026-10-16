# Audio

Plays an Audio asset from an actor, at the start of Play or when a script says so.

## Add it

Select an actor, then choose **Add Component > Audio > Audio**. You can also place a ready-made actor from **Place Actors > Audio > Audio**. An Audio asset listed in **Place Actors** creates an actor that already has it assigned.

## Settings

| Setting | Description |
| --- | --- |
| Audio | The [Audio](../assets/audio.md) asset to play. Play On Start needs one. |
| Play On Start | Starts the sound when Play begins. Default on. |
| Loop | Repeats the sound until it is stopped. Default off. |
| Volume | Level from 0 to 1, multiplied with the Audio asset's own volume. Default 1. |

## Notes

- Works in world scenes and in Scene Layers.
- The sound is spatial when the Audio asset uses a [Sound Attenuation](../assets/sound-attenuation.md) asset. It then plays from the actor's position, and a selected Audio component shows its inner and maximum radius in the viewport.
- Sound starts only after the player has clicked or tapped the game view.
- Scripts can use the component's **Play** and **Stop** functions and its **Volume** and **Loop** variables. [Event On Audio Finished](../scripting/class/event-on-audio-finished.md) runs when a sound that does not loop ends.
- To play a sound without a component, use [Play Sound](../scripting/class/play-sound.md).

## Related

- [Audio](../audio/index.md)
- [Spatial audio](../audio/spatial-audio.md)
