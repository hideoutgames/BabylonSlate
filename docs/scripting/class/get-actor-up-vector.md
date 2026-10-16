# Get Actor Up Vector

Returns the direction above an actor, as a unit vector along its up axis.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- Up is the actor's +Y axis.
- It is worked out from the actor's own rotation value, so a parent's rotation is not included.
