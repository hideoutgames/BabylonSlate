---
node: actor.isHiddenInGame
---

# Is Actor Hidden In Game

True while the actor is hidden.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Hidden | Boolean |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Reads what [Set Actor Hidden In Game](set-actor-hidden-in-game.md) and the actor's **Visible** setting in the scene set.
