# Importing Assets

Bring images, models, sounds and fonts into your project. Each file becomes one or more assets in the current Content Browser folder.

## Import files

1. In the **Content Browser**, open the folder you want the assets in.
2. Choose **Import** (<kbd>Alt</kbd>+<kbd>I</kbd>).
3. Pick one or more files, or a ZIP of them. Pick a model's companion files at the same time (for example a `.gltf` with its `.bin` and textures, or an `.obj` with its `.mtl`).

The **Importing** window shows each file and how far along it is. Slow conversions, such as HDR panoramas and large models, run in the background so the editor stays responsive. **Cancel** stops the import and removes the assets it already made, so the folder is left as it was.

If some files fail, **Import Partially Completed** lists the errors; the rest are imported. A file that fails leaves none of its assets behind.

On iPhone and iPad the file picker shows every file, including types iOS does not recognise, such as FBX. A file Haptic cannot import is listed with the import errors.

## Import a ZIP

Pick a `.zip` to import everything in it at once, such as an asset pack you downloaded.

- Haptic makes a folder named after the ZIP in the current folder (`Props.zip` makes **Props**) and keeps the folders inside the ZIP. If a folder of that name exists, the new one is **Props_1**, then **Props_2**, and so on.
- When everything in the ZIP is inside one folder, as when you compress a folder on a Mac, that folder is not repeated: `Props.zip` holding `Props/Chair/chair.glb` imports as **Props/Chair**.
- Models find their companion files by their paths inside the ZIP, so a `.gltf` with its `.bin` and textures, or an `.obj` with its `.mtl` and textures, imports complete.
- The **Importing** window shows **Unzipping** while it reads the ZIP. **Cancel** removes the new folder and everything in it.

Haptic skips these and lists them in **Import Partially Completed**:

- Files it cannot import, such as text files.
- Mac metadata (the `__MACOSX` folder) and hidden files whose names start with a dot, such as `.DS_Store`.
- ZIPs inside the ZIP. Unzip them and import them on their own.
- Encrypted files, and files compressed with anything other than standard ZIP compression.
- Files whose path inside the ZIP starts at the top of a drive or climbs out of the ZIP with `..`, or has a folder name the Content Browser cannot use.

A ZIP can hold up to 10,000 files and folders, and the files Haptic imports from it can add up to 512 MB once unzipped. Split a larger pack into several ZIPs.

## Supported formats

| Files | Become |
| --- | --- |
| PNG, JPEG, WebP, GIF | [Texture](../assets/texture.md) |
| ENV, DDS (prefiltered cube maps) | Environment cube [Texture](../assets/texture.md) for image-based lighting |
| HDR (equirectangular Radiance panoramas) | Converted on import to an environment cube [Texture](../assets/texture.md) |
| GLB, glTF | [Model](../assets/model.md), plus its Textures, [Materials](../assets/material.md), [Skeleton](../assets/skeleton.md) and [Animations](../assets/animation.md) |
| FBX, OBJ (with MTL), STL | Converted on import, then the same as glTF |
| MP3, WAV, OGG | [Audio](../assets/audio.md) |
| TTF, OTF, WOFF, WOFF2 | [Font](../assets/font.md) |
| MSDF atlas (JSON with its PNG) | [Font](../assets/font.md) |
| Haptic asset files (`.hasset`) | The same asset, copied from another project |

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

### Environment cubes

ENV and DDS files must already be prefiltered cube maps: Haptic keeps their faces and roughness mips as they are. DDS cubes must be linear RGBA16F or RGBA32F with a full mip chain.

An `.hdr` file is an equirectangular panorama in Radiance RGBE format, as most HDRI sites publish. Haptic converts it on import to a prefiltered RGBA16F DDS cube:

- Faces are up to **Engine Settings > Assets > HDR Import Face Size** (**128 × 128**, **256 × 256** or **512 × 512**; 256 by default), and never larger than about a quarter of the panorama's width.
- Each mip level holds the reflection for a rougher surface, from mirror-sharp to fully rough.
- The panorama's centre faces forward (+Z) and its top row is straight up.

Large panoramas can take a few seconds to convert, and 512 takes about four times as long as 256. The game loads the converted cube like any other DDS, so it does no conversion at load. The Texture keeps the `.hdr` (it is not included in exported games), so you can change its **Face Size** later in its **Inspector**. See [Texture](../assets/texture.md).

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
- GLB, glTF and FBX files are processed in the background, and **Cancel** stops them at once. An OBJ or STL file that is already converting finishes first, then the import stops.
- Pick a glTF's texture files in the same import as the model. A texture file you leave out is skipped: the model still imports, its materials use their plain colours, and **Import Partially Completed** lists the missing files.
- Open the Model to check its preview and colliders. See [Model](../assets/model.md) and [Models](../graphics/models.md).

## Sounds and fonts

- Audio files are stored in their original format. See [Audio](../assets/audio.md).
- Font files and MSDF atlases become Font assets. See [Font](../assets/font.md).

::: tip
Plugins (`.hplugin`) are not imported here. Use **Project Settings > Plugins > Import Plugin**. See [Plugins](../projects/plugins.md).
:::
