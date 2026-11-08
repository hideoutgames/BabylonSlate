---
node: system.isDevelopmentBuild
---

# Is Development Build

Returns true unless the game is a release export.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Development Build | Boolean | True in the editor, in Preview Build and in exports that bundle the debugger. False in a release export. |

## Notes

- A release export is one exported without the debugger, which also leaves out Development Only nodes such as [**Print**](print.md).
- Useful for debug menus and cheats that must never reach players.
