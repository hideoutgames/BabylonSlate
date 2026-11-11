---
node: debug.executeConsoleCommand
---

# Execute Console Command

Runs a console command and waits for it to finish.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Command | String | The full command line with its arguments, as you would type it in the Play console, for example `volume 0.5`. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec | Runs when the command ran without error. |
| Failed | Exec | Runs when it did not. |
| Output | String | The text the command returned. |
| Error | String | Why the command failed; empty on success. |

## Notes

- Only works while the game is running; in Editor Utility graphs **Failed** always runs.
- **Failed** also runs for an unknown command, a failing command, or after the session has ended.
- Commands that exist only for debugging are not available in exported games without the debugger.
- Latent: the node finishes later without pausing the rest of the game.
