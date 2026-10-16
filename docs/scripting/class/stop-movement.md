---
node: navigation.stopMovement
---

# Stop Movement

Stops an actor that is walking along a navigation path.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Clears the destination set by [**Move To**](move-to.md).
- Does nothing if the actor has no Nav Agent component.
