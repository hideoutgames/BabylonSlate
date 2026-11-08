---
node: audio.fadeOut
---

# Fade Out Sound

Lowers a sound to silent over time, then stops it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |
| Fade Out Duration | Float | Seconds the fade takes. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A duration of 0 or below stops the sound at once.
- Fades count real time, so slow motion does not slow them.
- A handle whose sound has ended or stopped does nothing.
