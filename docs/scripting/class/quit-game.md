---
node: system.quitGame
---

# Quit Game

Ends the game.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The game ends when the current simulation step finishes, so the nodes after it still run once.
- In the editor, Play stops. In an exported game, the game stops and its page stays open: browsers do not let a page close its own tab.
- The same as the `quit` console command.
