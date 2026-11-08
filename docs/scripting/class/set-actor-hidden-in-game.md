---
node: actor.setHiddenInGame
---

# Set Actor Hidden In Game

Hides or shows the actor and all its components. Actors attached to it keep their own visibility; collision is unchanged.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference |  |
| New Hidden | Boolean | True hides the actor, false shows it again. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Hiding an actor hides every component it draws. Actors attached to it keep their own visibility.
- A hidden actor still collides, ticks and plays its sounds.
- [Set Visibility](set-visibility.md) hides one component instead.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
