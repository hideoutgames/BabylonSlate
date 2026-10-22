---
node: input.vibrateDevice
---

# Vibrate Device

Vibrates the phone or tablet for a set time.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Duration | Float | How long to vibrate, in milliseconds, up to 10 seconds. 0 stops a vibration. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Works in browsers on Android phones and tablets, and in Play in the Haptic app on Android.
- iPhone and iPad browsers do not let web pages vibrate, iPads have no vibration motor, and computers have none either. There, the node does nothing.
- Browsers vibrate only after the player has tapped or clicked the game, and may refuse when the game is embedded in another site's page.
- To vibrate a gamepad, use [Set Gamepad Rumble](set-gamepad-rumble.md).
