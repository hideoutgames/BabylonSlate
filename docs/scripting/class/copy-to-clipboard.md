---
node: system.copyToClipboard
---

# Copy To Clipboard

Copies text to the device's clipboard.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Text | String | The text to copy. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Browsers allow copying only shortly after the player taps, clicks or presses a key, so run it from a button or key press.
- When the browser refuses, nothing is copied and the game continues. The node cannot tell you whether the copy worked.
