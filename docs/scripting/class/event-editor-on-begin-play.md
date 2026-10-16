# Event Editor On Begin Play

Runs when the editor loads an Editor Utility Object.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Runs first, before [**Event On Editor Startup**](event-on-editor-startup.md).
- Only in Editor Utility Object classes listed under **Project Settings &gt; General &gt; Editor Utility Objects**. It never runs in Play or in exported games.
- Editor Utility graphs only.
