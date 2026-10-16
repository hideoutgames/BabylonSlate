---
node: saveGame.newGame
---

# New Game

Resets the game's save data to its defaults, ready for a fresh playthrough.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Success | Boolean |  |
| Error Code | String | Empty on success; otherwise missing, corrupt, incompatible, storage-full, unavailable, invalid or apply-failed. |
| Error Message | String |  |
| Save Data | Any | The default Save Game's data after the reset. |

## Notes

- Waits until it finishes, then runs **Completed** or **Failed**.
- Actors registered for saving return to their starting state, and registered spawned actors are removed.
- Saved slots are not deleted; a damaged slot needs [**Delete Save**](delete-save.md) before it can be replaced.
- Latent: the node finishes later without pausing the rest of the game.
