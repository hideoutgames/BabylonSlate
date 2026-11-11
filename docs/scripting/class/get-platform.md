---
node: system.getPlatform
---

# Get Platform

Returns the operating system of the device the game runs on.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Platform | Platform | iOS, Android, Windows, macOS, Linux or Other. |

## Notes

- Exported games run in a browser, so this is the device's system, not the browser: a game played in Safari on an iPad reports iOS.
- Chromebooks report Linux. Systems Haptic does not recognize report Other.
- **Platform** is a built-in Enum: compare it with **Equal** or branch on it with **Switch On Enum**.
- To choose touch or mouse controls, use [**Is Touch Device**](is-touch-device.md) instead, since computers can have touch screens too.
