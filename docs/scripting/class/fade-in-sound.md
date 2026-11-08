---
node: audio.fadeIn
---

# Fade In Sound

Raises a sound from silent to a volume over time.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |
| Fade In Duration | Float | Seconds the fade takes. Defaults to 1. |
| Volume | Float | Level from 0 to 1, multiplied with the Audio asset's own volume. Defaults to 1, and other values are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Connect it straight after **Play Sound** so the sound starts silent.
- A duration of 0 or below sets the volume at once.
- Fades count real time, so slow motion does not slow them.
- A handle whose sound has ended or stopped does nothing.
