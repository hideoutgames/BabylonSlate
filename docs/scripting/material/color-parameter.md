---
node: param.color
---

# Color Parameter

Outputs a named colour that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| RGBA | Vector4 | Red, green, blue and alpha. |
| RGB | Vector3 | Red, green and blue only, for three-channel inputs such as **Base Color**. |
| A | Float | Alpha only, for one-channel inputs such as **Opacity**. |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. A taken name gets **_1**, **_2** and so on. |
| Type | **Float**, **Vector2**, **Vector3**, **Vector4**, **Color** or **Texture**. Changing it turns the node into that parameter, resizing the default. |
| Per Instance | Lets each actor drawn with the material have its own value while still drawing together with the others. |
| Color | The default colour, picked with the colour picker. |
| Default Value | The default red, green, blue and alpha values as numbers. |

## Notes

- The colour is picked in display (sRGB) space and converted to linear for shading.
- Set it from a Node Graph with **Set Material Color Parameter**.
- For four numbers that are not a colour, use a [**Vector4 Parameter**](vector4-parameter.md), which is not converted.
- Names are unique across all parameters in the material, whatever their type. A new, copied or pasted parameter gets a free name.
- With **Per Instance** on, an actor that changes only per-instance parameters keeps sharing the material, so many actors with different values still draw in one batch. Changing any other parameter on an actor gives that actor its own copy of the material.
- **Per Instance** applies to the material's own parameters, not to parameters inside a Material Function.
