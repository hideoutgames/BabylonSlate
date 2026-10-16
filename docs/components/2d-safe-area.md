# 2D Safe Area

A box that keeps its content clear of device cut-outs and rounded corners, with optional extra insets.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Safe Area**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Safe Area**.

Make the HUD elements children of this actor. To cover the whole layer, set Width and Height to the layer's **Layer Width** and **Layer Height**.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed uses Width or Height. Content fits the size of the largest child. Fill takes a share of the space left in the parent. Default Fixed. |
| Width, Height | Size of the box in layer units. Shown when the mode is Fixed. Default 4. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |
| Gap | No effect on a Safe Area, because its children share one area. |
| Horizontal Alignment, Vertical Alignment | Start, Center, End or Stretch. Places each child inside the box; Stretch makes it fill the box on that axis. |
| Padding Left, Padding Right, Padding Top, Padding Bottom | Space between the box edge and its children, in layer units. |
| Use Safe Area | Turns the device's safe area on or off for the whole box. Default on. |
| Safe Left, Safe Right, Safe Top, Safe Bottom | Whether the device's safe area applies on each edge. Default on. |
| Inset Left, Inset Right, Inset Top, Inset Bottom | Extra space added on each edge, in layer units. Default 0. |

## Notes

- Scene Layers only.
- The device's safe area covers notches, camera cut-outs, rounded corners and home indicators. It is added to the padding on each edge for which Safe Left, Right, Top or Bottom is on.
- The Inset values always apply. The editor's layer view shows only these. The device's safe area applies in Play and in exported games.
- Children share one area like those of a [2D Overlay Box](2d-overlay-box.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Scene Layer](../assets/scene-layer.md)
- [2D Anchor](2d-anchor.md)
- [2D Padding](2d-padding.md)
