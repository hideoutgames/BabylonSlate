---
node: audio.stopSound
---

# Stop Sound

Stops a playing sound at once.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | SoundHandle | The sound's handle from **Play Sound** or **Play Sound At Location**. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A handle whose sound has ended or stopped does nothing.
- To stop gently, use [**Fade Out Sound**](fade-out-sound.md).
