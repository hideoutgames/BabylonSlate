---
node: interface.call
---

# Call Interface Function

Calls a Script Interface method on another object and continues when it returns.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | Object to call. Left unconnected, it calls the object that runs the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Add Node** lists one Call Interface entry for each method of each Script Interface in the project; the method's inputs and outputs appear as extra pins.
- If the target does not implement the interface, no handler runs, **Out** still runs and the outputs return their defaults.
