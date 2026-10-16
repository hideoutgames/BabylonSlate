# Event On Editor Shutdown

Runs when the project closes or its Editor Utility Objects are reloaded.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Runs once per shutdown; use it to clean up anything started in [**Event On Editor Startup**](event-on-editor-startup.md).
- Only in Editor Utility Object classes; it never runs in Play or in exported games.
- Editor Utility graphs only.
