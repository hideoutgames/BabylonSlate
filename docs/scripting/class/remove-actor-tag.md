---
node: tags.removeActorTag
---

# Remove Actor Tag

Takes Tag off the actor; its child Tags stay.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Tag | Tag |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Removes only that exact Tag: removing `Enemy` leaves `Enemy.Boss`.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
