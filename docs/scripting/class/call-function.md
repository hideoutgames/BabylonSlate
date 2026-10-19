---
node: functions.call
---

# Call Function

Calls a function defined on a class and continues when it returns.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | Object that owns the function. For a function of this graph's own class the pin reads **Target (Self)** and calls the object running the graph; connect another object of the class to call that one instead. Not shown for Function Library functions. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Add Node** lists a Call entry for each function on this class, its parents and other classes; the function's inputs and outputs appear as extra pins.
- If the function waits (for example it contains a [**Delay**](delay.md)), **Out** runs after it finishes.
- If the target is empty or invalid, nothing runs and the outputs return their defaults. An empty **Target** also logs an error.
- A function of another class needs its **Target** connected.
