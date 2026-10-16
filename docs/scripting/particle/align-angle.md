---
node: update.alignAngle
---

# Align Angle

Rotates each particle so its up direction follows its direction of travel on screen.

## Inputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Settings

| Setting | Description |
| --- | --- |
| Alignment | Offset in radians added to the facing angle. The default of 1.5708 (pi divided by 2) points the particle's up direction along its travel. |

## Notes

- It uses the view of the active camera, so it has no effect when the scene has no active camera.
