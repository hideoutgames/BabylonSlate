---
node: input.getTouchCount
---

# Get Touch Count

Returns how many touches the game view has this tick.

## Outputs

| Pin | Type |
| --- | --- |
| Count | Integer |

## Notes

- Touches that ended this tick still count, once, with their **Phase** set to **Ended** or **Cancelled**.
- Loop from 0 to **Count** minus 1 with [Get Touch](get-touch.md) to read every touch.
