---
node: system.isGamePaused
---

# Is Game Paused

Returns true while the game is paused.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Paused | Boolean | The state the last [**Set Game Paused**](set-game-paused.md) asked for. |

## Notes

- Reports a change at once, even though the pause itself starts with the next simulation step.
- Pausing Play with the editor's **Pause** button does not change it.
