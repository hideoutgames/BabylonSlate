---
node: time.getTimeNow
---

# Get Time Now

Returns the current time of day in UTC.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Time | Time | The time of day, in UTC. |

## Notes

- **Time** is a built-in Structure. Use **Break Time** to read its fields, all Floats holding whole numbers: **Hour** (0 to 23), **Minute** (0 to 59), **Second** (0 to 59) and **Millisecond** (0 to 999).
- For the player's own time zone, use [**Get Local Time Now**](get-local-time-now.md).
- All fields you break from one **Get Time Now** in one step come from the same moment.
- Reads the device clock, so the result changes between runs and depends on the device's clock being right. Use [**Get Delta Seconds**](get-delta-seconds.md) to measure game time.
