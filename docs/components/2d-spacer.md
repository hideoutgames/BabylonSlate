# 2D Spacer

Adds empty space inside a box, either a fixed size or a flexible share of what is left.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Spacer**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Spacer**. Put it between the elements it should separate, inside a 2D Vertical Box or 2D Horizontal Box.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed and Content use Width or Height. Fill takes a share of the space left in the parent. Default Fill. |
| Width, Height | Size in layer units, used when the mode is not Fill. Default 1. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |

## Notes

- Scene Layers only.
- A Spacer with Fill takes whatever room the other children leave, so it pushes them apart. Two Fill spacers with equal weights centre the elements between them.
- It draws nothing.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Vertical Box](2d-vertical-box.md)
- [2D Horizontal Box](2d-horizontal-box.md)
- [2D Padding](2d-padding.md)
