---
node: force.gravity
---

# Gravity

Accelerates every particle by changing its direction each frame.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Acceleration | Vector 3 (m/s²) | (0, -9.81, 0) | Acceleration in metres per second squared. The default points straight down. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- It changes velocity only, so the chain also needs [**Apply Velocity**](apply-velocity.md) to move particles.
