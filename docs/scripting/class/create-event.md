---
node: flow.delegate.create
---

# Create Event

A delegate that runs a chosen custom event or function on an object. Connect it to a Bind or Unbind node, or to any Delegate input.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Object | Object Reference | The object whose event or function runs. While unconnected it shows **Self** and uses the object running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Event | Delegate |

## Notes

- Choose the event or function in the node itself. The list shows the custom events and functions of the **Object**'s class and its parents. When **Event** is connected, it shows only those that take the connected delegate's inputs.
- **Create Matching Event** and **Create Matching Function** add a new custom event or function of this class with those inputs and choose it.
- A function that returns values cannot be chosen.
- When the chosen event or function changes its inputs, **Compiler Results** reports it; choose it again.
