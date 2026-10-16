---
node: string.parseFloat
---

# Parse Float

Converts text such as 3.5 into a Float and reports whether it worked.

## Inputs

| Pin | Type |
| --- | --- |
| In | String |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Float |  |
| Success | Boolean | True when **In** is valid number text. |

## Notes

- Accepts an optional minus sign, digits with an optional decimal part, and an optional exponent such as e3, ignoring spaces at either end.
- Anything else, including numbers too large to represent, gives 0 on **Out** and false on **Success**.
