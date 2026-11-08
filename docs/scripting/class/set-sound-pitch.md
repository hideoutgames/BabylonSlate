---
node: audio.setSoundPitch
---

# Set Sound Pitch

Changes the pitch of a playing sound.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |
| Pitch Multiplier | Float | Multiplies the Audio asset's own pitch. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- 2 plays an octave higher and twice as fast, 0.5 an octave lower and half as fast. The multiplier is kept between 0.25 and 4.
- A handle whose sound has ended or stopped does nothing.
