# 2D Padding

Insets the content of its parent without drawing anything or taking a layout slot.

## Add it

Place a ready-made helper from **Place Actors > Overlay > 2D Padding** and drag it under the box in the Outliner. Or add a new empty child actor to the box, select it, then choose **Add Component > Overlay > 2D Padding**.

## Settings

| Setting | Description |
| --- | --- |
| Padding Left | Space added on the left edge, in layer units. Default 0. |
| Padding Right | Space added on the right edge. Default 0. |
| Padding Top | Space added on the top edge. Default 0. |
| Padding Bottom | Space added on the bottom edge. Default 0. |

## Notes

- Scene Layers only.
- It affects only its immediate parent, and adds to any padding already set on the parent box.
- It has no size and no visual. Hidden helpers are ignored.
- Boxes have their own four padding settings. 2D Padding adds to them.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Vertical Box](2d-vertical-box.md)
- [2D Horizontal Box](2d-horizontal-box.md)
- [2D Spacer](2d-spacer.md)
