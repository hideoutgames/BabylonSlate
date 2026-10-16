# Material Function

A reusable shader subgraph for Materials.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Material Function**.

## Editor

Double-tap a Material Function to open it.

- **Graph**: the subgraph. Start and end it with [Function Inputs](../scripting/material/function-inputs.md) and [Function Outputs](../scripting/material/function-outputs.md).
- **Interface**: the function's pins. Under **Inputs** and **Outputs**, add pins, name them and choose their types. Select an input to set its **Default Value**.
- **Inspector**: the function's settings, or the selected node's properties.
- **Compiler Results**: problems with the graph.

## Settings

| Setting | Description |
| --- | --- |
| Description | A short note about what the function does. |

## Notes

- Call the function from a Material with a [Material Function](../scripting/material/material-function.md) node.
- Renaming a pin does not break the Materials that already call the function.
- Parameters inside a function are internal. To change a value from outside, expose it as a function input.

## Related

- [Materials](../graphics/materials.md)
- [Material](material.md)
- [Material nodes](../scripting/material/index.md)
