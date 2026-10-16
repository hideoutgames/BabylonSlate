---
node: scene.change
---

# Change Scene

Leaves the current Scene and loads another one.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Scene | Scene Asset | The Scene asset to load. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Actors in the current Scene are removed and the new Scene loads in their place.
- The Game Instance carries over.
