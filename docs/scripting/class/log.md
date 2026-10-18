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

- While you play, the message appears in the **Output Log** as `[Category] message`, with **Warning:** or **Error:** in front for those severities, and in the Play [console](../../debugging/console.md).
- Error entries are also reported as runtime errors for the session.
