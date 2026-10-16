# Texture

An image used by Materials, Sprites, Tilesets, Skyboxes and particles, with a usage that decides how Haptic stores it.

## Import

Textures are not created from **New Asset**. In the **Content Browser**, choose **Import** and pick a PNG, JPEG, WebP or GIF file. ENV and DDS prefiltered cube maps become an environment cube Texture. [Skybox Creator](skybox-creator.md) also creates Textures. Haptic chooses a **Usage** from the file name. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** shows the image at **Fit** or **Actual Size**, with its usage and pixel size. A cube Texture shows **Environment Cube** instead, because cube faces are not previewed.
- The **Inspector** has **Import**, **Compression** and **Area Light Emission**.

## Settings

| Setting | Description |
| --- | --- |
| Usage | **Albedo**, **Normal**, **Pixel Art**, **UI**, **Skybox**, **Particle** or **Color Grading LUT**. Changing it can start a new compression. |
| Downsample | Store the texture at **Full**, **1/2**, **1/4**, **1/8** or **1/16** size. |
| Compression Quality | Quality of the GPU compression. Shown for Albedo, Normal and Particle only. |
| Dependencies | How many assets this Texture depends on. Read-only; shown when there are any. |

**Compression** shows a state: **Not Compressed**, **Queued**, **Encoding**, **Compressed** or **Failed**. Albedo, Normal and Particle Textures are compressed in the background. The other usages stay uncompressed so their pixels are exact. If encoding fails, the Inspector shows the error and **Retry Encoding**.

**Area Light Emission** prepares the Texture for a textured [Rectangular Area Light](../components/area-rect-light.md). Choose **Prepare Emission**; **Cancel** stops it. Prepared data is saved with the asset and included in game exports.

A cube Texture has no editable settings. Its Inspector shows the cube's container, encoding, face size and roughness mip levels. Pick it in **Environment Texture** under **Environment Lighting** in the scene's settings.

## Related

- [Importing Assets](../editor/importing.md)
- [Skybox](../components/skybox.md)
- [Sprite](sprite.md)
- [Material](material.md)
