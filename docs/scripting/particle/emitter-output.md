# Emitter Output

Ends the Particle chain and sets how many particles the emitter spawns each second.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Emit Rate | Float (/s) | 30 | Particles spawned per second. It cannot read particle attributes, [**Emitter Position**](emitter-position.md) or [**Camera Position**](camera-position.md). |

## Settings

| Setting | Description |
| --- | --- |
| Material | The particle-domain Material that draws the particles. The emitter does not render without one. |
| Capacity | The most particles alive at once, from 16 to 4096. Particle Graphs simulate on the CPU, so values above 512 cost more. |
| Loop | Infinite keeps emitting until stopped. Once stops emitting after **Duration**. |
| Duration | Seconds the emitter spawns particles before it stops, from 0.05 to 600. Used only when **Loop** is Once. |
| Pre Warm | Seconds simulated before the first frame, from 0 to 10. Applies to Infinite loops only. |
| Blend Mode | How particles blend with the scene: Additive, Normal, Alpha Additive, Multiply or Subtract. |
| Billboard | How particles face the camera: Camera Facing, Y Axis or Stretched. |

## Notes

- Every Particle Graph has exactly one Emitter Output, and you cannot delete it.
- Select it, or select nothing, to edit the emitter settings in Details.
