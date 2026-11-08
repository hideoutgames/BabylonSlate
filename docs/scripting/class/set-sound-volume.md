---
node: audio.setSoundVolume
---

# Set Sound Volume

Changes the volume of a playing sound.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |
| Volume | Float | Level from 0 to 1, multiplied with the Audio asset's own volume. Defaults to 1, and other values are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Setting the volume ends a fade in progress.
- A handle whose sound has ended or stopped does nothing.
