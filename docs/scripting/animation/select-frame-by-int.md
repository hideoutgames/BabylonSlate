---
node: anim.frame.selectByInt
---

# Select Frame By Int

Shows the frame Active Index picks.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Frame0 | Frame | The frame at index 0. |
| Frame1 | Frame | The frame at index 1. |
| Active Index | Integer | The frame to show. Defaults to 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Frame | Frame |

## Notes

- Set **Frames**, the number of frame inputs from 2 to 16, in the **Inspector**.
- An index outside the range picks the nearest frame.
