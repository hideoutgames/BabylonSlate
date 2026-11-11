---
node: global.parameter
---

# Global Parameter

Returns one parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md): a value the whole game shares, which any Class graph can set while it plays.

## Settings

| Setting | Description |
| --- | --- |
| Collection | The Global Parameter Collection to read from. Picking another one clears **Parameter**. |
| Parameter | One of the collection's parameters. The node is named after it, for example **Wind Strength (Global Float)**. |

## Notes

- Its **Value** output takes the parameter's type: Float, Vector2, Vector3 or Color. Without a parameter the node has no output, and its wires are removed.
- The value is the parameter's default until a Class graph sets it with **Set Global Float Parameter**, **Set Global Vector Parameter** or **Set Global Color Parameter**. Every running emitter that reads it takes the new value on its next frame, and so does every Material.
- Values start at their defaults when Play starts, keep across Scene changes and are never saved.
- Editing a default in the collection updates previews and a running Play at once. In Play, a parameter a Class graph has already set keeps its value.
- Unlike a graph [Parameter](parameter.md), it cannot be set per Particle component: it is the same for every emitter.
- A warning shows when no parameter is selected, when the parameter has left its collection or when its type has changed. Select the parameter again to update the node.
