---
node: debug.reportCommand
---

# Report Command

Sets the success flag and output text returned by the running console command.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Success | Boolean |
| Output | String |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Use it in a graph started by [**Event On Command Run**](event-on-command-run.md).
- A command that never calls it finishes with success and no output.
- Calling it again replaces the earlier result.
