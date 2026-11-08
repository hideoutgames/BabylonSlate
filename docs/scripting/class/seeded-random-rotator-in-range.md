---
node: random.seededRotatorInRange
---

# Seeded Random Rotator In Range

Returns a random rotator inside the range, with each axis drawn on its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Range | Rotator Range | The range to draw from. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Rotator |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Rotator In Range](random-rotator-in-range.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes three steps, Pitch, Yaw then Roll. Each step adds 1 to the Seed variable's **Step**.
- See [Curves and ranges](../curves-and-ranges.md).
