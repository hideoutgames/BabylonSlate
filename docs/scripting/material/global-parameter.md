---
node: global.parameter
---

# Global Parameter

Outputs one parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md): a value the whole game shares, which any Class graph can set while it plays.

## Settings

| Setting | Description |
| --- | --- |
| Collection | The Global Parameter Collection to read from. Picking another one clears **Parameter**. |
| Parameter | One of the collection's parameters. The node is named after it, for example **Sky Tint (Global Color)**. |

## Notes

- Its output follows the parameter's type. A Float, Vector 2 or Vector 3 parameter gives one **Out** pin. A Color gives **RGBA** (Vector 4) and **RGB** (Vector 3), like a [Color Parameter](color-parameter.md).
- Without a parameter the node has no output.
- The value is the parameter's default until a Class graph sets it with **Set Global Float Parameter**, **Set Global Vector Parameter** or **Set Global Color Parameter**. Every Material and Particle Graph that reads the parameter then draws the new value, without recompiling.
- Values start at their defaults when Play starts, keep across Scene changes and are never saved.
- Editing a default in the collection updates the Material preview, the Scene viewport and a running Play at once. In Play, a parameter a Class graph has already set keeps its value.
- A Color is picked in display (sRGB) space and converted to linear for shading.
- A Material Instance cannot override it; it is the same for every Material.
- A warning shows when no parameter is selected, when the parameter has left its collection or when its type has changed. Select the parameter again to update the node.
