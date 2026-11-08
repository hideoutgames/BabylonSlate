---
node: time.getCurrentFrameCount
---

# Get Current Frame Count

Returns how many frames the game has finished since Play started.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Frame Count | Integer | Frames finished before the current one. It reads 0 during the first frame. |

## Notes

- Goes up by one every simulation step and keeps counting across scene changes.
- Returns 0 in Editor Utility Objects, which do not run a simulation.
