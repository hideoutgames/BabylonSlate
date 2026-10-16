# 2D Scroll Box

A box that clips its content to a window and lets the player scroll it.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Scroll Box**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Scroll Box**.

Add the content as child actors or child components of the box. Content larger than the window scrolls along the Scroll Axis.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed uses Width or Height. Content fits the size of the children. Fill takes a share of the space left in the parent. Default Fixed. |
| Width, Height | Size of the window in layer units. Shown when the mode is Fixed. Default 4. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |
| Gap | No effect on a Scroll Box, because its children share one area. |
| Horizontal Alignment, Vertical Alignment | Start, Center, End or Stretch. Default Start. |
| Padding Left, Padding Right, Padding Top, Padding Bottom | Space between the window edge and the content, in layer units. |
| Scroll Axis | Vertical, Horizontal or Both. Default Vertical. |
| Scroll X, Scroll Y | Current scroll offset, in layer units. Limited to the scrollable range. |

## Notes

- Scene Layers only.
- Players scroll with the mouse wheel (hold <kbd>Shift</kbd> to scroll sideways) or by dragging with touch or pen.
- A touch or pen drag that starts scrolling cancels the button press underneath it: On Press End fires and On Click does not.
- Clipping applies to drawing and to clicks. Hidden or disabled boxes do not scroll.
- Keyboard and gamepad focus scrolls an offscreen target into view.
- Animate the offset with [Tween Scroll Offset](../scripting/class/tween-scroll-offset.md), or resize the window with [Tween Layout Size](../scripting/class/tween-layout-size.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Vertical Box](2d-vertical-box.md)
- [2D Virtualized List](2d-virtualized-list.md)
