# Save Game

Writes the current save data to a slot.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Slot | String | Names the save slot, such as a manual save. Empty uses the project's default slot. |
| Profile | String | Names the player profile, such as one per character. Empty uses the project's default profile. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Success | Boolean |  |
| Error Code | String | Empty on success; otherwise missing, corrupt, incompatible, storage-full, unavailable, invalid or apply-failed. |
| Error Message | String |  |
| Save | SaveGameInfo | Details of the save that was written: its slot, profile, sequence number and time. |

## Notes

- Waits until it finishes, then runs **Completed** or **Failed**; a failed save keeps the last valid save.
- Empty **Slot** and **Profile** use the project defaults.
- Actors with a Save Game component also save the state selected on it.
- Latent: the node finishes later without pausing the rest of the game.
