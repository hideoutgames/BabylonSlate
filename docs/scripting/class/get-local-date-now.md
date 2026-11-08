---
node: time.getLocalDateNow
---

# Get Local Date Now

Returns today's date in the device's time zone.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Date | Date | The calendar date on the device's clock. |

## Notes

- Returns the same **Date** Structure as [**Get Date Now**](get-date-now.md): use **Break Date** to read **Year**, **Month**, **Day**, **Day Of Week** and **Day Of Year**.
- The date changes at the player's local midnight, which is what a daily reward or streak usually wants.
- Reads the device clock, so the result changes between runs and depends on the player's settings.
