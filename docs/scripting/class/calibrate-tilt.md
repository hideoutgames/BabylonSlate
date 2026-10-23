---
node: input.calibrateTilt
---

# Calibrate Tilt

Makes the device's current pose the zero point for tilt.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Affects **Tilt** on [Get Device Motion](get-device-motion.md) and the **Tilt X** and **Tilt Y** controls of Input assets.
- Call it when play starts or from a recenter button, so players can hold the device at any angle.
- Before the device sends its first reading, it does nothing.
