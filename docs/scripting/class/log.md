---
node: debug.log
---

# Log

Writes a message to the Output Log with a chosen severity and category.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Message | String |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Severity | Verbose, Log, Warning or Error. Defaults to Log. |
| Category | Label shown with the message. Defaults to Script. |

## Notes

- Error entries are also reported as runtime errors for the session.
