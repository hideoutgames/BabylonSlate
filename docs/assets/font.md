# Font

A typeface for 2D Text, 2D Rich Text and 3D Text, imported from a font file.

## Create

Fonts are imported, not created from **New Asset**. In the **Content Browser**, choose **Import** and pick a TTF, OTF, WOFF or WOFF2 file. An MSDF atlas (a JSON glyph map with its PNG) also becomes a Font. See [Importing](../editor/importing.md).

To add an MSDF atlas to an existing Font, hold the Font in the **Content Browser** and choose **Import MSDF Atlas…**.

## Editor

Double-tap a Font to open it. The window has **Preview** and an **Inspector**.

- **Preview**: type in the sample field and set **Size** to see the font. Below the sample, a waterfall shows it from 12 to 48 pixels, and **Glyphs** shows letters, digits and common symbols. The toolbar lists any sample characters that fall back to another font.
- **Inspector**: **Family**; **Fallbacks**, other Fonts tried in order for characters this font does not cover; and **Representations**, which shows whether the Font has a **Source Font**, **Typeface**, **MSDF JSON** and **MSDF Atlas** (**Present** or **Missing**). **Import MSDF Atlas** sits on the Representations header.

## Settings

| Setting | Description |
| --- | --- |
| Family | The family name of the font. |
| Sample text and Size | The preview's text and size only; not saved. |
| Fallbacks | Other Fonts to try, in order, for characters this font lacks. **Add Fallback** picks a Font. |
| MSDF Atlas | **Import MSDF Atlas** attaches a JSON and PNG pair to this Font. |

In **Project Settings > Fonts**, **Default Font** is used when a requested font is unavailable, and **Global Fallback** picks the generic family (such as sans-serif) used last.

## Notes

- 2D Text and 2D Rich Text draw with **Renderer** set to **Bitmap** or **MSDF**. **MSDF** is available only when the Font has both the MSDF JSON and the MSDF Atlas.
- 3D Text uses the Font's typeface data. Without it, the text uses a built-in typeface with basic ASCII characters.
- Play, Preview Build and exported games load each Font before they draw the text that uses it, and 2D Text with no Font uses the **Default Font**. If a Font cannot be loaded, for example because its file is damaged, loading stops with an error that names the Font instead of drawing the text in another font.

## Related

- [Importing](../editor/importing.md)
- [2D Text](../components/2d-text.md)
- [2D Rich Text](../components/2d-rich-text.md)
- [3D Text](../components/text-3d.md)
