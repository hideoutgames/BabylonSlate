---
node: output.ui
---

# User Interface Output

Sets the colour and opacity of a 2D element drawn with a User Interface material.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Color | Vector3 | (1, 1, 1) | The colour of each pixel of the element. |
| Opacity | Float | 1 | From 0 (invisible) to 1 (solid). |

## Notes

- The component's **Tint** and **Opacity** multiply the result, so you can fade or tint the element without changing the material.
- **Blend Mode** is **Translucent** (default) or **Additive**. The material is always unlit and two-sided.
- Assign the material to a 2D Material, 2D Panel, 2D Joystick or 2D control in a Scene Layer. See [User Interface Materials](../../graphics/materials.md#user-interface-materials).
- Use [**User Interface Input**](user-interface-input.md) and the shape nodes, such as [**Rounded Rectangle**](rounded-rectangle.md), to draw shapes in pixels.
- Only in User Interface materials.
