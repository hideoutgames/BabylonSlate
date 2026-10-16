# Set Channel Volume

Sets the volume of an Audio Channel for the current session.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Channel | AudioChannel Asset |  |
| Volume | Float | Level from 0 to 1. Defaults to 1, and other values are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The channel must be on the Audio Mixer chosen in **Project Settings &gt; Audio**. Otherwise a warning is logged and nothing changes.
- Applies at once to sounds already playing, without editing the Audio Channel or Audio Mixer assets.
