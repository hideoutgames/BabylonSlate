---
node: time.getLocalTimeNow
---

# Get Local Time Now

Returns the current time of day in the device's time zone.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Time | Time | The time of day on the device's clock. |

## Notes

- Returns the same **Time** Structure as [**Get Time Now**](get-time-now.md): use **Break Time** to read **Hour**, **Minute**, **Second** and **Millisecond**.
- Follows the player's time zone and daylight saving time, so it suits clocks and "come back tomorrow" rewards. Use [**Get Time Now**](get-time-now.md) when every player must see the same moment.
- Reads the device clock, so the result changes between runs and depends on the player's settings.
