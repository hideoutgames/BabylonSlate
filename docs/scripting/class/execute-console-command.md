# Execute Console Command

Runs a console command and waits for it to finish.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Command | String | The full command line with its arguments, as you would type it in the Play console, for example `volume 0.5`. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the command ran without error. |
| Output | String | The text the command returned, or the error message. |

## Notes

- Only works while the game is running; in Editor Utility graphs **Success** is always false.
- **Success** is also false for an unknown command, a failing command, or after the session has ended.
- Commands that exist only for debugging are not available in exported games without the debugger.
- Latent: the node finishes later without pausing the rest of the game.
