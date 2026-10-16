# 2D Mask

Clips an actor and everything under it to a rectangle, without affecting layout.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Mask**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Mask**.

Put it on the actor whose visuals you want to clip. Or add it to an empty child actor to clip that child's parent, the same way a [2D Padding](2d-padding.md) helper works.

## Settings

| Setting | Description |
| --- | --- |
| Width | Width of the visible rectangle, in layer units. Default 4. |
| Height | Height of the visible rectangle, in layer units. Default 4. |

## Notes

- Scene Layers only.
- The rectangle is centred on the mask. Anything outside it, on the owning actor, its other components and its child actors, is not drawn and cannot be clicked.
- The mask takes no layout slot and does not move or resize anything it clips. It does not clip siblings of the owning actor.
- Masks combine with other clips, such as those of a scroll box, and only the overlap shows.
- Hidden masks do nothing.
- To arrange children and clip them in one step, use a [2D Mask Panel](2d-mask-panel.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Mask Panel](2d-mask-panel.md)
- [2D Scroll Box](2d-scroll-box.md)
