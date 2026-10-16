---
node: shape.box
---

# Box Shape

Spawns particles at random points inside a box and launches them between two directions.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Direction 1 | Vector 3 | (0, 1, 0) | One end of the range the launch direction is picked from. |
| Direction 2 | Vector 3 | (0, 1, 0) | The other end of that range. |
| Box Min | Vector 3 | (-0.5, -0.5, -0.5) | The corner of the box with the lowest X, Y and Z values. |
| Box Max | Vector 3 | (0.5, 0.5, 0.5) | The corner of the box with the highest X, Y and Z values. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- The box is positioned relative to the emitter.
- Each particle gets a random direction between **Direction 1** and **Direction 2**, picked separately for each axis.
