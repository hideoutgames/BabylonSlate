# Set Global Volume

Sets the master volume of the selected Audio Mixer for the current session.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Volume | Float | Level from 0 to 1. Defaults to 1, and other values are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Needs an Audio Mixer chosen in **Project Settings &gt; Audio**, otherwise a warning is logged and nothing changes.
- Applies at once to sounds already playing, without editing the Audio Mixer asset.
