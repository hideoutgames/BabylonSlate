# Point Shape

Spawns particles at the emitter and launches them in a direction picked between two vectors.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Direction 1 | Vector 3 | (0, 1, 0) | One end of the range the launch direction is picked from. |
| Direction 2 | Vector 3 | (0, 1, 0) | The other end of that range. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- Each particle gets a random direction between **Direction 1** and **Direction 2**, picked separately for each axis.
- Set both to the same vector to launch every particle the same way.
