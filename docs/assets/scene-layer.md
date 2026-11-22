# Scene Layer

An unlit 2D overlay that draws on top of world Scenes: a HUD, a pause menu or a title screen.

## Create

In the **Content Browser**, choose **New Asset > World > Scene Layer**.

## Editor

Double-tap a Scene Layer to open it.

- **Viewport**: always 2D and unlit, over a neutral mid grey that stands in for the world (a [Multiply](material.md#multiply-on-scene-layers) element darkens it). The orange frame is the layer's design canvas, placed by its **Canvas Size** and **Root Pivot**. It draws at the screen's full resolution and quality, as the game does, whatever the Scalability level or Engine Settings.
- **Outliner**: the layer's actors. Tap **+** to place them; **Place Actors** adds an **Overlay** category of ready-made 2D elements.
- **Inspector**: the selected actor, or the layer's settings when nothing is selected.
- **Output Log** and **Compiler Results**: messages and script errors.
- **Scene Mode** picker: **Design** or **Script**. Script edits the layer's own [Scene Layer Script](../scripting/scene-scripts.md).

Overlay components, such as 2D Text and 2D Button, work only in Scene Layers.

## Settings

Clear the selection to show **Scene Settings** in the **Inspector**.

| Setting | Description |
| --- | --- |
| Name | The layer's display name. |
| Enable Physics | Off by default. When on, each copy of the layer simulates its Rigid Bodies and Colliders in its own 2D world. |
| Gravity | Gravity for that 2D world. |
| Canvas Size | **Fullscreen** (the default: the project's Custom Resolution, or 1920 × 1080 without one), **Desired** (the bounds of the content) or **Custom** (**Custom Size** in pixels). |
| Root Pivot | The point of the canvas on the layer's origin and on the matching point of the screen. Default **Center**. |
| Canvas Scaling | **Fit To Screen** (the default) scales the canvas to the screen without stretching; **True Pixel Size** shows it at its pixel size. |
| Camera Location | Where the layer's camera starts, as an offset from the view the canvas gives it. Default 0, 0. |
| Scene Layer Post-Processing | The project's passes shared by every layer, the same list as **Project Settings > Rendering > Scene Layer Post-Processing**. **Add Pass** picks a Material. See [Scene Layer post-processing](../scenes/scene-layers.md#scene-layer-post-processing). |

## Related

- [Scene Layers](../scenes/scene-layers.md) ([Canvas size and scaling](../scenes/scene-layers.md#canvas-size-and-scaling))
- [Scene](scene.md)
- [Class](class.md)
- [Post-Processing](../graphics/post-processing.md)
- [Create Scene Layer](../scripting/class/create-scene-layer.md)
