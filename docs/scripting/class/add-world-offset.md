# Add World Offset

Moves an actor by adding an offset to its current location.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Offset | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The offset is in world units and is added on each axis. For an attached actor, it is added to the location relative to the parent.
- A value that is not a finite number changes nothing.
