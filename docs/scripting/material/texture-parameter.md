---
node: param.texture
---

# Texture Parameter

Outputs a named texture that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Texture |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. A taken name gets **_1**, **_2** and so on. |
| Type | **Float**, **Vector2**, **Vector3**, **Vector4**, **Color** or **Texture**. Changing it turns the node into that parameter, resizing the default. |
| Texture | The default texture asset. |

## Notes

- Connect it to the **Texture** input of [**Texture Sample**](texture-sample.md).
- Set it from a Node Graph with **Set Material Texture Parameter**.
