# Global Parameter Collection

A **Global Parameter Collection** holds named Float, Vector2, Vector3, Vector4 and Color values that the whole game shares while it plays, such as wind strength or a sky tint. Any Class graph can set a value, and every graph, Material and Particle Graph that reads it uses the new value.

## Create

In the **Content Browser**, choose **New Asset > Data > Global Parameter Collection**. A new collection has no parameters.

## Editor

Double-tap a collection to open it. The **Parameters** window lists its parameters. Tap **Add Parameter** to add one.

| Setting | Description |
| --- | --- |
| Name | The name Class graphs set and read it by, up to 64 characters. Names are unique in the collection: a name that is already taken gets **_1**, **_2** and so on. |
| Type | **Float**, **Vector2**, **Vector3**, **Vector4** or **Color**. Changing it resizes the default. A Color is converted from display colour to linear where a Material reads it; a Vector4 is four numbers passed as they are. |
| Default | The value the parameter has when Play starts. |

Reorder or delete a parameter with the buttons on its row. Reopen a closed window from the **Windows** menu.

## Use it in graphs

- [Set Global Float Parameter](../scripting/class/set-global-float-parameter.md), [Set Global Vector2 Parameter](../scripting/class/set-global-vector2-parameter.md), [Set Global Vector3 Parameter](../scripting/class/set-global-vector3-parameter.md), [Set Global Vector4 Parameter](../scripting/class/set-global-vector4-parameter.md) and [Set Global Color Parameter](../scripting/class/set-global-color-parameter.md) change a value. Each sets only a parameter of its own type.
- [Get Global Float Parameter](../scripting/class/get-global-float-parameter.md), [Get Global Vector2 Parameter](../scripting/class/get-global-vector2-parameter.md), [Get Global Vector3 Parameter](../scripting/class/get-global-vector3-parameter.md), [Get Global Vector4 Parameter](../scripting/class/get-global-vector4-parameter.md) and [Get Global Color Parameter](../scripting/class/get-global-color-parameter.md) read it.
- Pick the collection on the **Collection** pin. The **Parameter** pin then lists the collection's parameters of the node's type. While **Collection** is empty or wired, **Parameter** is a name you type.
- In a Material or a Particle Graph, the [Material Global Parameter](../scripting/material/global-parameter.md) and [Particle Graph Global Parameter](../scripting/particle/global-parameter.md) nodes read one parameter. Pick the **Collection** and the **Parameter** in the **Inspector**; the node is named after the parameter, for example **Sky Tint (Global Color)**, and its output takes the parameter's type.

## Values

- Every value starts at its default when Play starts and keeps what a graph set until Play ends, also across Scene changes. Values are never saved.
- A value is the same for the whole game: setting it in one graph changes it for every graph, Material and Particle Graph that reads it.
- Editing a default updates Material and Particle previews, the Scene viewport and a running Play at once. In Play, a parameter a graph has already set keeps its value.
- A collection loads with the graphs that use it.

## Related

- [Curve](curve.md)
- [Data Tree](data-tree.md)
