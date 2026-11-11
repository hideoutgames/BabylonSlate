---
node: param.vec4
---

# Vector4 Parameter

Outputs four named numbers that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector4 |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. A taken name gets **_1**, **_2** and so on. |
| Type | **Float**, **Vector2**, **Vector3**, **Vector4**, **Color** or **Texture**. Changing it turns the node into that parameter, resizing the default. |
| Value | The default value. |

## Notes

- The four numbers reach the shader as authored. Use it for data, such as a rectangle, a direction with a strength, or a UV scale with an offset.
- For a colour use a [**Color Parameter**](color-parameter.md) instead: it is picked as a display colour and converted to linear for shading, so its numbers are not the ones you typed.
- Set it from a Node Graph with [**Set Material Vector4 Parameter**](../class/set-material-vector4-parameter.md).
- Names are unique across all parameters in the material, whatever their type. A new, copied or pasted parameter gets a free name.
