# Load Game

Restores the game from a saved slot.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Slot | String | Names the save slot. Empty uses the project's default slot. |
| Profile | String | Names the player profile. Empty uses the project's default profile. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Success | Boolean |  |
| Error Code | String | Empty on success; otherwise missing, corrupt, incompatible, storage-full, unavailable, invalid or apply-failed. |
| Error Message | String |  |
| Save | SaveGameInfo | Details of the save that was loaded: its slot, profile, sequence number and time. |

## Notes

- Waits until it finishes, then runs **Completed** or **Failed**; a failed load leaves the current game unchanged.
- A slot with no save runs **Failed** with the error code missing.
- [**Event On Game Loaded**](event-on-game-loaded.md) runs after the saved state is restored.
- Latent: the node finishes later without pausing the rest of the game.
