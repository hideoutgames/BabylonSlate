---
node: string.parseInt
---

# Parse Int

Converts text such as 42 into an Integer and reports whether it worked.

## Inputs

| Pin | Type |
| --- | --- |
| In | String |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Integer |  |
| Success | Boolean | True when **In** is valid whole-number text. |

## Notes

- Accepts an optional minus sign followed by digits, ignoring spaces at either end.
- Decimals, letters and empty text give 0 on **Out** and false on **Success**.
