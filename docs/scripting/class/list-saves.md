# List Saves

Lists the saved slots of a profile.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Profile | String | Names the player profile. Empty uses the project's default profile. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Success | Boolean |  |
| Error Code | String | Empty on success; otherwise missing, corrupt, incompatible, storage-full, unavailable, invalid or apply-failed. |
| Error Message | String |  |
| Saves | Array of SaveGameInfo | One entry per slot, sorted by slot name. Empty if the node fails. |

## Notes

- Waits until it finishes, then runs **Completed** or **Failed**.
- An empty **Profile** uses the project's default profile.
- Each entry has a status of ok, corrupt or incompatible, so damaged slots are listed too.
- Latent: the node finishes later without pausing the rest of the game.
