# Render Target

The image a scene capture renders into: what it records and how many pixels it has.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Render Target**. Then pick it in the **Render Target** field of a [Render Target Capture](../components/render-target-capture.md) component. To show the result on a mesh, add a [Render Target Texture](render-target-texture.md) for it.

## Editor

Double-tap the asset to open it. The window has an **Inspector** only.

## Settings

| Setting | Description |
| --- | --- |
| Render Mode | **Scene Color** (default) captures the lit scene. **Depth Pass** stores distance from the capture, from near (0) to far (1). **World Normal** stores surface directions. |
| Width, Height | Size in pixels, from 1 to 4096. Default 512 by 512. |

Depth Pass and World Normal skip scene lighting and post-processing.

## Notes

- Large or many Render Targets use GPU memory. Keep sizes as small as the effect allows.

## Related

- [Render Targets](../graphics/render-targets.md)
- [Render Target Capture](../components/render-target-capture.md)
- [Render Target Texture](render-target-texture.md)
