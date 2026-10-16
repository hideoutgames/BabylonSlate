# Set Gamepad Rumble

Vibrates a gamepad for a set time.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Index | Integer | Zero-based gamepad number, where 0 is Gamepad 1. |
| Intensity | Float | Strength from 0 (off) to 1 (full). Other values are clamped. |
| Duration | Float | How long to vibrate, in milliseconds. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- An intensity or duration of 0 stops the vibration.
- Gamepads without vibration, and indexes that are negative or not whole numbers, are ignored.
