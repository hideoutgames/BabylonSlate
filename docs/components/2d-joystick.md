# 2D Joystick

An on-screen touch joystick that feeds two axes into your Input Axis assets.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Joystick**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Joystick**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Background Material | Material for the fixed base: a [User Interface](../graphics/materials.md#user-interface-materials) Material or an Instance of one. Empty draws a plain circle. |
| Joystick Material | Material for the moving stick: a [User Interface](../graphics/materials.md#user-interface-materials) Material or an Instance of one. Empty draws a plain circle. |
| Background Radius | Radius of the base in layer units. Default 1.5. |
| Joystick Radius | Radius of the stick in layer units. Default 0.6. It cannot exceed 95% of the Background Radius. |
| Dead Zone | Fraction of the travel, from 0 to 0.99, that is ignored. Past it, the value rises smoothly to 1. Default 0.1. |
| Horizontal Axis | Which Touch binding the left and right movement drives: Joystick X, Joystick Y, D-Pad X or D-Pad Y. Default Joystick X. |
| Vertical Axis | Which Touch binding the up and down movement drives. Default Joystick Y. |

## Notes

- Scene Layers only.
- Scripts read it through a 2D [Input Axis](../assets/input-axis.md) with matching Touch controls. In the Input Axis, choose **Add Control > Touch** twice: pick **Joystick X** with **Direction** set to **X · Horizontal**, and **Joystick Y** with **Y · Vertical** (or the axes you chose above). Right and up are positive.
- The Material pickers accept a User Interface [Material](../assets/material.md) or a [Material Instance](../assets/material-instance.md) of one. Materials of other domains are not listed, and are not drawn if a script sets one. Materials are square, so cut a round shape with an [Ellipse](../scripting/material/ellipse.md) wired into **Opacity**.
- Mouse, touch and pen use the same path. A finger or pointer owns the joystick until it is released, even outside the base, and another finger cannot take it over. Release, cancel, pause or hiding the joystick returns the axes to zero.
- To drive two independent sticks, give the second one D-Pad X and D-Pad Y.

## Related

- [Input](../input/index.md)
- [Scene Layers](../scenes/scene-layers.md)
