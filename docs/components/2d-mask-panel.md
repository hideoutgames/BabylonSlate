# 2D Mask Panel

A box that clips everything inside it to its own rectangle.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Mask Panel**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Mask Panel**.

The panel arranges its actor's child actors and any components attached beneath it. Parts that stick out of the panel are cut off.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed uses Width or Height. Content fits the size of the largest child. Fill takes a share of the space left in the parent. Default Fixed. |
| Width, Height | Size of the panel in layer units. Shown when the mode is Fixed. Default 4. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |
| Gap | No effect on a Mask Panel, because its children share one area. |
| Horizontal Alignment, Vertical Alignment | Start, Center, End or Stretch. Places each child inside the panel; Stretch makes it fill the panel on that axis. |
| Padding Left, Padding Right, Padding Top, Padding Bottom | Space between the panel edge and its children, in layer units. The clipped area is inside this padding. |

## Notes

- Scene Layers only.
- Children share one area like those of a [2D Overlay Box](2d-overlay-box.md). The clip applies to drawing and to clicks.
- Clips from nested panels and scroll boxes combine, and only the overlap shows.
- Use it to reveal a bar as it fills, wipe an image in, or crop content. Animate the size with [Tween Layout Size](../scripting/class/tween-layout-size.md) when the mode is Fixed.
- To clip an actor's own visuals without changing any layout, use a [2D Mask](2d-mask.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Mask](2d-mask.md)
- [2D Scroll Box](2d-scroll-box.md)
- [2D Overlay Box](2d-overlay-box.md)
