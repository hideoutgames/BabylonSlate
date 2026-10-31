---
node: param.color
---

# Color Parameter

Outputs a named colour that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| RGBA | Vector 4 | Red, green, blue and alpha. |
| RGB | Vector 3 | Red, green and blue only, for three-channel inputs such as **Base Color**. |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. |
| Per Instance | Lets each actor drawn with the material have its own value while still drawing together with the others. |
| Color | The default colour, picked with the colour picker. |
| Default Value | The default red, green, blue and alpha values as numbers. |

## Notes

- The colour is picked in display (sRGB) space and converted to linear for shading.
- Set it from a Node Graph with **Set Material Color Parameter**.
- Names must be unique across all parameters in the material, whatever their type.
- With **Per Instance** on, an actor that changes only per-instance parameters keeps sharing the material, so many actors with different values still draw in one batch. Changing any other parameter on an actor gives that actor its own copy of the material.
- **Per Instance** applies to the material's own parameters, not to parameters inside a Material Function.
