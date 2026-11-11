---
node: time.getTimeMs
---

# Get Time In Milliseconds

Returns the current Unix time in milliseconds.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Milliseconds | Float | Milliseconds since 1 January 1970, 00:00 UTC. |

## Notes

- Useful for timestamps, for example in a save game, or for measuring real time that ignores pauses and time dilation.
- Reads the device clock, so the result changes between runs and can jump if the player changes the clock.
