---
node: system.setGamePaused
---

# Set Game Paused

Pauses or resumes the game.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Paused | Boolean | On to pause, off to resume. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Takes effect from the next simulation step. [**Is Game Paused**](is-game-paused.md) reports the new state at once.
- While the game is paused, only these keep running:
  - actors whose class has **Tick On Pause** in **Actor Defaults**, with their components;
  - every actor in a Scene Layer that has **Tick On Pause**, and that layer's Scene Layer Script;
  - the Game Instance, when its class has **Tick On Pause** in **Game Instance Defaults**.
- Those keep their Event Tick, input events, [**Delay**](delay.md) nodes and tweens, and their sounds keep playing. Everything else holds where it is: other actors, Game and Scene Subsystems, physics, animation, timelines, behaviour trees, navigation, particles and other sounds.
- Taps, clicks and other UI events still reach every actor, so a pause menu button can resume the game.
- [**Get Game Time In Seconds**](get-game-time-in-seconds.md) stops while the game is paused. [**Get Real Time In Seconds**](get-real-time-in-seconds.md) keeps counting.
- This is separate from the editor's **Pause** button, which stops everything.
