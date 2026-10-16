# Delete Save

Deletes a saved slot, including the older copies kept for migration.

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

## Notes

- Waits until it finishes, then runs **Completed** or **Failed**.
- Empty **Slot** and **Profile** use the project defaults.
- Use it to clear a damaged slot before saving to it again.
- Latent: the node finishes later without pausing the rest of the game.
