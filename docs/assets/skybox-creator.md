# Skybox Creator

An editor tool that cuts one cross-layout image into six skybox face Textures.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Skybox Creator**. You need a [Texture](texture.md) laid out as a 4×3 cube cross. Skybox Creator does not convert panoramic (equirectangular) images.

## Editor

Double-tap the asset to open it. The window has **Preview**, **Cubemap** and an **Inspector**.

1. In **Preview**, choose **Pick Texture** and pick the source Texture.
2. Line up the Texture with the **Up**, **Left**, **Front**, **Right**, **Back** and **Down** cells of the net: drag it to move it, drag a corner or edge handle to resize it, drag the round handle above it to rotate it (hold <kbd>Shift</kbd> for 15° steps) or pinch it with two fingers to scale it. The part outside the net stays visible at half strength.
3. Drag the empty space around the net to move the view; pinch or use the mouse wheel to zoom. **Fit** returns to the whole net.
4. Check the result in **Cubemap**: drag to look around.
5. Choose **Create Skybox Textures**. The status shows how many of the 6 faces are created.
6. Assign the new Textures to the face slots of a [Skybox](../components/skybox.md) component.

**Create Skybox Textures** is also in the **Inspector**. It needs a source Texture. Haptic writes the six Textures next to this asset, with Usage set to **Skybox**. Choosing it again replaces the same six Textures, so existing Skybox slots stay connected.

## Settings

| Setting | Description |
| --- | --- |
| Texture | The source image. Picking another resets the alignment. |
| Placement | **Position**, **Size**, **Rotation** and **Scale** of the Texture on the net, for exact values. Position and size are percentages of the net's width and height; a scale of 100% is the largest size that fits the net. **Fit To Net** returns to that fit. |
| Generated Faces | Read-only list of the faces created so far, such as **Up (+Y)** and **Left (−X)**. A face that does not exist shows **Not Created**. |

## Related

- [Sky and fog](../graphics/sky-and-fog.md)
- [Skybox](../components/skybox.md)
- [Texture](texture.md)
