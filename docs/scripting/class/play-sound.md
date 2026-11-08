---
node: audio.play
---

# Play Sound

Plays an Audio asset, positioned at the actor running the graph when the sound is spatial.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Asset | Audio Asset |  |
| Volume | Float | Level from 0 to 1, multiplied with the Audio asset's own volume. Defaults to 1, and other values are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Handle | SoundHandle |

## Notes

- Whether the sound loops follows the Audio asset's Loop setting.
- A sound is spatial when its Audio asset uses a Sound Attenuation asset.
- Audio starts only after the player has clicked or tapped the game view.
- Keep **Handle** to [stop](stop-sound.md), [fade](fade-out-sound.md) or change the sound's [volume](set-sound-volume.md) or [pitch](set-sound-pitch.md) later.
