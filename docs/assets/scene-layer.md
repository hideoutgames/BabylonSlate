# Scene Layer

An unlit 2D overlay that draws on top of world Scenes: a HUD, a pause menu or a title screen.

## Create

In the **Content Browser**, choose **New Asset > World > Scene Layer**.

## Editor

Double-tap a Scene Layer to open it.

- **Viewport**: always 2D and unlit. The orange frame is the layer's design canvas, centred on the origin.
- **Outliner**: the layer's actors. Tap **+** to place them; **Place Actors** adds an **Overlay** category of ready-made 2D elements.
- **Inspector**: the selected actor, or the layer's settings when nothing is selected.
- **Output Log** and **Compiler Results**: messages and script errors.

Overlay components, such as 2D Text and 2D Button, work only in Scene Layers.

## Settings

Clear the selection to show **Scene Settings** in the **Inspector**.

| Setting | Description |
| --- | --- |
| Name | The layer's display name. |
| Enable Physics | Off by default. When on, each copy of the layer simulates its Rigid Bodies and Colliders in its own 2D world. |
| Gravity | Gravity for that 2D world. |
| Layer Width, Layer Height | Size of the design canvas in layer units. Default 32 × 18. |
| Post Processing | Post-process passes applied to this layer only. **Add Pass** picks a Material. |

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Scene](scene.md)
- [Class](class.md)
- [Post-Processing](../graphics/post-processing.md)
- [Create Scene Layer](../scripting/class/create-scene-layer.md)
