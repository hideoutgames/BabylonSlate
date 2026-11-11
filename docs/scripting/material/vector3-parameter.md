---
node: param.vec3
---

# Vector3 Parameter

Outputs a named Vector3 that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector3 |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. A taken name gets **_1**, **_2** and so on. |
| Type | **Float**, **Vector2**, **Vector3**, **Color** or **Texture**. Changing it turns the node into that parameter, resizing the default. |
| Value | The default value. |

## Notes

- Set it from a Node Graph with **Set Material Vector Parameter**.
- Names are unique across all parameters in the material, whatever their type. A new, copied or pasted parameter gets a free name.
- The value is used as authored, without colour conversion.
