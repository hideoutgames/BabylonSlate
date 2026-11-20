# Post Processing Panel

Runs a post-process Material over the part of a Scene Layer inside its rectangle, such as a blur behind a menu or a glitch on one HUD element.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > Post Processing Panel**. You can also place a ready-made actor from **Place Actors > Overlay > Post Processing Panel**.

Everything on the actor and under it in the Outliner is the panel's content: its own visuals and every child, grandchild and further descendant.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Off, the content draws as under any other actor and the panel costs nothing. Default on. |
| Material | A [Material](../assets/material.md) whose **Domain** is **Post Process**, or a Material Instance of one. It runs over the panel's content in the game. **None** (the default) draws the content as if the panel were not there. |

## How it draws

- The panel is the actor's square, sized by the actor's scale as a [2D Panel](2d-panel.md) is. Resize it with the box around the actor in the viewport.
- In the game, the content draws into an image the size of the panel's rectangle on screen, in screen pixels. The Material runs over that image, and the result takes the panel's place in the layer, in Z-Order with the layer's other elements. Read the content with [Scene Color](../scripting/material/scene-color.md); where nothing is drawn it is transparent.
- Content outside the rectangle is cut off.
- A panel inside another panel draws first. Its result is part of the outer panel's content.
- The [Scene Layer post-processing](../scenes/scene-layers.md#scene-layer-post-processing) passes run afterwards over every layer, the panel's result included, as they do without panels.
- Taps and clicks reach the content where it shows: inside the rectangle, as if the Material were not there.
- Part of the panel off screen: only the part on screen is drawn. All of it off screen: nothing of it is drawn.

## Notes

- Scene Layers only.
- The editor viewport draws the content without the Material. It runs only in the game.
- Each enabled panel with a Material costs an image of its size and one pass every frame, and its content no longer shares draw calls with the rest of the layer. Resizing the panel makes a new image. Leave **Enabled** off, or the Material empty, when you do not need it.
- Child actors inherit the actor's scale, as under any scaled actor.
- Change the Material's parameters while the game runs: call **Get Material** on the component, or read its **Material Object** variable, and use [Set Material Float Parameter](../scripting/class/set-material-float-parameter.md) or the other Set Material Parameter nodes. **Get Material** is empty while the panel has no Material.
- Switch the panel on and off with its **Enabled** variable.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Post-Processing](../graphics/post-processing.md)
- [2D Mask Panel](2d-mask-panel.md)
- [2D Panel](2d-panel.md)
