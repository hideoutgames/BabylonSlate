---
node: audio.isSoundPlaying
---

# Is Sound Playing

Returns whether a sound is still playing.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |

## Outputs

| Pin | Type |
| --- | --- |
| Playing | Boolean |

## Notes

- True from **Play Sound** until the sound ends, is stopped or has faded out. A looping sound plays until it is stopped.
