---
node: audio.getSoundVolume
---

# Get Sound Volume

Returns the volume of a playing sound.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |

## Outputs

| Pin | Type |
| --- | --- |
| Volume | Float |

## Notes

- The volume the sound has now, from 0 to 1, also in the middle of a fade.
- 0 once the sound has ended or was stopped.
