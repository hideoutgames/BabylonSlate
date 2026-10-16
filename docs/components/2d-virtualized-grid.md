# 2D Virtualized Grid

A scrolling grid of identical items that creates only the items in view.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Virtualized Grid**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Virtualized Grid**.

Make a Class whose parent is **SceneLayerActor** for one item, then pick it as the **Item Class**. Without an Item Class, the grid lays out its own child actors in the same cells and draws only the ones in view.

## Settings

| Setting | Description |
| --- | --- |
| Width Mode, Height Mode | Fixed uses Width or Height. Content fits the size of the children. Fill takes a share of the space left in the parent. Default Fixed. |
| Width, Height | Size of the window in layer units. Shown when the mode is Fixed. Default 4. |
| Fill Weight | Weight for sharing the leftover space with other Fill siblings. Default 1. |
| Gap | Space between items, across and down, in layer units. |
| Horizontal Alignment, Vertical Alignment | No effect. Items sit in the grid cells. |
| Padding Left, Padding Right, Padding Top, Padding Bottom | Space between the window edge and the items, in layer units. |
| Scroll Axis | Vertical. A grid scrolls only up and down. |
| Scroll X, Scroll Y | Current scroll offset, in layer units. Limited to the scrollable range. |
| Item Class | The **SceneLayerActor** Class to create for each item. None by default. |
| Item Count | How many items the grid holds. Default 0. |
| Item Width, Item Height | Size of every cell in layer units. Default 1. |
| Overscan | Extra rows kept beyond the top and bottom so items are ready before they scroll in. Default 1, up to 64. |
| Columns | Number of columns. 0 fits as many as the window width allows. Default 0. |

## Notes

- Scene Layers only.
- Items fill each row from left to right, then continue on the next row.
- Scrolling works like a [2D Scroll Box](2d-scroll-box.md): mouse wheel, or a touch or pen drag. Content outside the window is clipped for drawing and for clicks.
- Items leaving the visible range are destroyed, and new ones are created as the grid scrolls. Keep item data outside the item actors.
- Each item has a read-only **Item Index** variable. Read it in the item Class to fill the item with the right data.
- Limits: 2,048 live items per grid and 8,192 per Scene Layer. To prevent endless nesting, a grid does not create items of its own actor's Class or of the Class of any actor above it.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Class](../assets/class.md)
- [2D Virtualized List](2d-virtualized-list.md)
- [2D Scroll Box](2d-scroll-box.md)
