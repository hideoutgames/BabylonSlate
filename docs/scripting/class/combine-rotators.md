# Combine Rotators

Combines two rotators into a single rotation.

## Inputs

| Pin | Type |
| --- | --- |
| A | Rotator |
| B | Rotator |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Rotator |

## Notes

- Order matters: swapping **A** and **B** generally gives a different result.
- The rotations are combined as full 3D rotations, not by adding the angles axis by axis.
