# Font

A typeface for 2D Text, 2D Rich Text and 3D Text, imported from a font file.

## Create

Fonts are imported, not created from **New Asset**. In the **Content Browser**, choose **Import** and pick a TTF, OTF, WOFF or WOFF2 file. An MSDF atlas (a JSON glyph map with its PNG) also becomes a Font. See [Importing](../editor/importing.md).

To add an MSDF atlas to an existing Font, hold the Font in the **Content Browser** and choose **Import MSDF Atlas…**.

## Editor

Double-tap a Font to open it. The window has **Preview** and an **Inspector**.

- **Preview**: type in the sample field and set **Size** to see the font. Below the sample, a waterfall shows it from 12 to 48 pixels, and **Glyphs** shows letters, digits and common symbols. The toolbar lists any sample characters that fall back to another font.
- **Inspector**: **Family**; **Pixel Size**, which makes the Font a pixel font; **Fallbacks**, other Fonts tried in order for characters this font does not cover; and **Representations**, which shows whether the Font has a **Source Font**, **Typeface**, **MSDF JSON** and **MSDF Atlas** (**Present** or **Missing**). **Import MSDF Atlas** sits on the Representations header.

## Settings

| Setting | Description |
| --- | --- |
| Family | The family name of the font. |
| Pixel Size | For a pixel font: the height in pixels it was drawn for, from 1 to 128. 0 (default) is an ordinary font. See [Pixel fonts](#pixel-fonts). |
| Sample text and Size | The preview's text and size only; not saved. |
| Fallbacks | Other Fonts to try, in order, for characters this font lacks. **Add Fallback** picks a Font. |
| MSDF Atlas | **Import MSDF Atlas** attaches a JSON and PNG pair to this Font. Pick one JSON and the PNG it names. A JSON that names no atlas page pairs only with a PNG of the same name that contains `msdf`, such as `Ui-msdf.png` for `Ui-msdf.json`. A second JSON or any other PNG in the pick is refused. |

In **Project Settings > Fonts**, **Default Font** is used when a requested font is unavailable, and **Global Fallback** picks the generic family (such as sans-serif) used last.

## Pixel fonts

A pixel font is drawn on a grid, one square per pixel, at one size. Set its **Pixel Size** to that size, such as 12 for a 12-pixel font, and 2D Text and 2D Rich Text draw it pixel perfect:

- Every pixel of a letter is either fully drawn or empty, with no smoothing at the edges.
- The text draws at whole multiples of the Pixel Size. **Scale** on the text picks the multiple and replaces **Size** and **Renderer**. A `[size=…]` tag in Rich Text rounds to the nearest whole multiple.
- Letters sit on whole pixels, and **Outline** grows in whole font pixels.

With **Pixel-Perfect Mode** on (**Project Settings > Game > 2D**), **Scale** 1 draws one font pixel as one screen pixel of the game's resolution.

### Ark Pixel

Haptic includes the Ark Pixel font (SIL Open Font License) in four variants: 12px and 10px, each Proportional and Monospaced. A project created with **Pixel Art Optimized** imports all four into its `Fonts` folder as pixel fonts and makes **Ark Pixel 12px Proportional** the **Default Font**, so 2D Text there is pixel perfect from the start. The 12px variants cover Latin, Greek and Cyrillic letters and Chinese and Japanese characters. The 10px variants cover fewer Chinese and Japanese characters, and 10px Monospaced has no Greek or Cyrillic. Korean and other scripts come from the fallbacks below. Its license is listed in **Application Settings > Third-Party Notices** and in the notices every exported game includes.

### Characters a font lacks

A character that a Font does not cover is drawn with its **Fallbacks**, then the **Default Font**, then the **Global Fallback**. The Global Fallback uses the device's own fonts, which cover most writing systems, so text in any language still shows when a project's fonts lack it. A pixel font draws such characters on its pixel grid too.

## Notes

- 2D Text and 2D Rich Text draw with **Renderer** set to **Bitmap** or **MSDF**. **MSDF** is available only when the Font has both the MSDF JSON and the MSDF Atlas. A pixel font always draws as Bitmap.
- 3D Text uses the Font's typeface data. Without it, the text uses a built-in typeface with basic ASCII characters.
- Play, Preview Build and exported games load each Font before they draw the text that uses it, and 2D Text with no Font uses the **Default Font**. If a Font cannot be loaded, for example because its file is damaged, loading stops with an error that names the Font instead of drawing the text in another font.

## Related

- [Importing](../editor/importing.md)
- [2D Text](../components/2d-text.md)
- [2D Rich Text](../components/2d-rich-text.md)
- [3D Text](../components/text-3d.md)
