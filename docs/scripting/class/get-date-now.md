---
node: time.getDateNow
---

# Get Date Now

Returns today's date in UTC.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Date | Date | The calendar date, in UTC. |

## Notes

- **Date** is a built-in Structure. Use **Break Date** to read its Integer fields: **Year**, **Month** (1 to 12), **Day** (1 to 31), **Day Of Week** (0 for Sunday to 6 for Saturday) and **Day Of Year** (1 to 366).
- Uses UTC like [**Get Time Now**](get-time-now.md), so the two always describe the same moment. Near midnight the UTC date can differ from the player's local date; use [**Get Local Date Now**](get-local-date-now.md) for that.
- Reads the device clock, so the result changes between runs.
