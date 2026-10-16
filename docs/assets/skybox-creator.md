# Skybox Creator

An editor tool that cuts one cross-layout image into six skybox face Textures.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Skybox Creator**. You need a [Texture](texture.md) laid out as a 4×3 cube cross. Skybox Creator does not convert panoramic (equirectangular) images.

## Editor

Double-tap the asset to open it. The window has **Preview**, **Cubemap** and an **Inspector**.

1. In **Preview**, choose **Pick Texture** and pick the source Texture.
2. Drag the Texture to line up the **Up**, **Left**, **Front**, **Right**, **Back** and **Down** cells of the net.
3. Check the result in **Cubemap**, a 3D view you can look around.
4. Choose **Create Skybox Textures**. The status shows how many of the 6 faces are created.
5. Assign the new Textures to the face slots of a [Skybox](../components/skybox.md) component.

**Create Skybox Textures** is also in the **Inspector**. It needs a source Texture. Haptic writes the six Textures next to this asset, with Usage set to **Skybox**. Choosing it again replaces the same six Textures, so existing Skybox slots stay connected.

## Settings

| Setting | Description |
| --- | --- |
| Texture | The source image. Picking another resets the alignment. |
| Generated Faces | Read-only list of the faces created so far, such as **Up (+Y)** and **Left (−X)**. A face that does not exist shows **Not Created**. |

## Related

- [Sky and fog](../graphics/sky-and-fog.md)
- [Skybox](../components/skybox.md)
- [Texture](texture.md)
