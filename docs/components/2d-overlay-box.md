# 2D Overlay Box

Layers its children in the same area, with alignment placing each one.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Overlay Box**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Overlay Box**.

The box arranges its actor's child actors and any components attached beneath it.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed uses Width or Height. Content fits the size of the largest child. Fill takes a share of the space left in the parent. Default Fixed. |
| Width, Height | Size of the box in layer units. Shown when the mode is Fixed. Default 4. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |
| Gap | No effect on an Overlay Box, because its children share one area. |
| Horizontal Alignment, Vertical Alignment | Start, Center, End or Stretch. Places each child inside the box; Stretch makes it fill the box on that axis. |
| Padding Left, Padding Right, Padding Top, Padding Bottom | Space between the box edge and its children, in layer units. |

## Notes

- Scene Layers only.
- Use it for backgrounds with content on top, badges on corners, or any stack of elements that share one area.
- Boxes can be nested. Animate the size with [Tween Layout Size](../scripting/class/tween-layout-size.md) when the mode is Fixed.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Vertical Box](2d-vertical-box.md)
- [2D Horizontal Box](2d-horizontal-box.md)
