---
node: flow.event.editorStartup
---

# Event On Editor Startup

Runs when the editor starts the project's Editor Utility Objects.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Runs each time the project opens, and again when the list of Editor Utility Objects changes.
- Only in Editor Utility Object classes. It never runs in Play or in exported games.
- Editor Utility graphs only.
