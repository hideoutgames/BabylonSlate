---
node: audio.playAtLocation
---

# Play Sound At Location

Plays an Audio asset at a fixed point in the world.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Sound | Audio Asset |  |
| Location | Vector 3 | Where the sound is heard from. |
| Volume | Float | Level from 0 to 1, multiplied with the Audio asset's own volume. Defaults to 1, and other values are clamped. |
| Pitch Multiplier | Float | Multiplies the Audio asset's pitch, from 0.25 to 4. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Handle | SoundHandle |

## Notes

- The sound stays at **Location** however the actor running the graph moves.
- **Location** matters only when the Audio asset uses a Sound Attenuation asset; otherwise the sound is not spatial and plays like **Play Sound**.
- Keep **Handle** to stop, fade or change the sound later.
