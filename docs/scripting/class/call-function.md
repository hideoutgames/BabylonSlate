---
node: functions.call
---

# Call Function

Calls a function defined on a class and continues when it returns.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | Object that owns the function. Not shown for calls on the graph's own class or on Function Library functions. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Add Node** lists a Call entry for each function on this class, its parents and other classes; the function's inputs and outputs appear as extra pins.
- If the function waits (for example it contains a [**Delay**](delay.md)), **Out** runs after it finishes.
- If the target is invalid, nothing runs and the outputs return their defaults.
