# 2D Horizontal Box

Lines up its children from left to right.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Horizontal Box**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Horizontal Box**.

The box arranges its actor's child actors and any components attached beneath it, in Outliner order.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed uses Width or Height. Content fits the size of the children. Fill takes a share of the space left in the parent. Default Fixed. |
| Width, Height | Size of the box in layer units. Shown when the mode is Fixed. Default 4. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |
| Gap | Space between children, in layer units. |
| Horizontal Alignment | Start, Center or End places the whole row inside the box. |
| Vertical Alignment | Start, Center, End or Stretch. Places children up and down in the box; Stretch makes them as tall as the box. |
| Padding Left, Padding Right, Padding Top, Padding Bottom | Space between the box edge and its children, in layer units. |

## Notes

- Scene Layers only.
- The box sets its children's positions, so moving a child by hand has no lasting effect. Reorder children in the Outliner instead.
- A child box set to Fill width shares the leftover width with other Fill children, divided by Fill Weight.
- Hidden children take no space.
- Boxes can be nested. Animate the size with [Tween Layout Size](../scripting/class/tween-layout-size.md) when the mode is Fixed.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Vertical Box](2d-vertical-box.md)
- [2D Spacer](2d-spacer.md)
- [2D Padding](2d-padding.md)
