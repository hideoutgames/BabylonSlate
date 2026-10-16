# Importing Assets

Bring images, models, sounds and fonts into your project. Each file becomes one or more assets in the current Content Browser folder.

## Import files

1. In the **Content Browser**, open the folder you want the assets in.
2. Choose **Import** (<kbd>Alt</kbd>+<kbd>I</kbd>).
3. Pick one or more files. Pick a model's companion files at the same time (for example a `.gltf` with its `.bin` and textures, or an `.obj` with its `.mtl`).

A progress window shows each file. If some files fail, **Import Partially Completed** lists the errors; the rest are imported.

## Supported formats

| Files | Become |
| --- | --- |
| PNG, JPEG, WebP, GIF | [Texture](../assets/texture.md) |
| ENV, DDS (prefiltered cube maps) | Environment cube [Texture](../assets/texture.md) for image-based lighting |
| GLB, glTF | [Model](../assets/model.md), plus its Textures, [Materials](../assets/material.md), [Skeleton](../assets/skeleton.md) and [Animations](../assets/animation.md) |
| FBX, OBJ (with MTL), STL | Converted on import, then the same as glTF |
| MP3, WAV, OGG | [Audio](../assets/audio.md) |
| TTF, OTF, WOFF, WOFF2 | [Font](../assets/font.md) |
| MSDF atlas (JSON with its PNG) | [Font](../assets/font.md) |
| Haptic asset files (`.babasset`) | The same asset, copied from another project |

To add an MSDF atlas to an existing Font, hold the Font and choose **Import MSDF Atlas…**.

## Textures

Haptic picks a texture's **Usage** from whole words in its file name. Change it in the Texture's **Inspector**.

| File name contains | Usage |
| --- | --- |
| pixel, pixelart, sprite, spritesheet, tileset | Pixel Art |
| lut, colorgrading | Color Grading LUT |
| ui, gui, hud, button | UI |
| normal, normalmap | Normal |
| anything else | Albedo |

Other usages are **Skybox** and **Particle**.

### Compression

Albedo, Normal and Particle textures are compressed to GPU formats in the background after import and whenever you change their settings. Pixel Art, UI, Skybox and Color Grading LUT textures stay uncompressed so their pixels are exact.

| Setting | Description |
| --- | --- |
| Usage | What the texture is for. Changing it can start a new compression. |
| Downsample | Store the texture at Full, 1/2, 1/4, 1/8 or 1/16 size. |
| Compression Quality | Quality of the GPU compression. Shown for compressed usages only. |

The **Compression** section shows the current state. If compression fails, the Inspector shows the error and **Retry Encoding**. **Project Settings > Textures > Failed Encodes > Retry Encoding** retries every failed texture at once.

## Models

- **Engine Settings > Assets > Model Import Default Scale** sets the scale given to newly imported models. It does not change models you already imported.
- Open the Model to check its preview and colliders. See [Model](../assets/model.md) and [Models](../graphics/models.md).

## Sounds and fonts

- Audio files are stored in their original format. See [Audio](../assets/audio.md).
- Font files and MSDF atlases become Font assets. See [Font](../assets/font.md).

::: tip
Plugins (`.babplugin`) are not imported here. Use **Project Settings > Plugins > Import Plugin**. See [Plugins](../projects/plugins.md).
:::
