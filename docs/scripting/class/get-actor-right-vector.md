# Get Actor Right Vector

Returns the direction to an actor's right, as a unit vector along its right axis.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- Right is the actor's +X axis.
- It is worked out from the actor's own rotation value, so a parent's rotation is not included.
