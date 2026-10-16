# Font

A typeface for 2D Text, 2D Rich Text and 3D Text, imported from a font file.

## Create

Fonts are imported, not created from **New Asset**. In the **Content Browser**, choose **Import** and pick a TTF, OTF, WOFF or WOFF2 file. An MSDF atlas (a JSON glyph map with its PNG) also becomes a Font. See [Importing](../editor/importing.md).

To add an MSDF atlas to an existing Font, hold the Font in the **Content Browser** and choose **Import MSDF Atlas…**.

## Editor

Double-tap a Font to open it. The editor is a single **Font** panel with a live preview.

- Type in **Sample Text** to see the font. The line under the preview lists any glyphs that fall back to another font.
- Add **Fallbacks** for characters this font does not cover.
- **Representations** shows which parts the Font has: **Source Font**, **Typeface**, **MSDF JSON** and **MSDF Atlas**, each **Yes** or **Missing**.

## Settings

| Setting | Description |
| --- | --- |
| Family | The family name of the font. |
| Sample Text | Text for the preview only. |
| Fallbacks | Other Fonts to try, in order, for characters this font lacks. **Add Fallback** picks a Font. |
| MSDF Atlas | **Import MSDF Atlas…** attaches a JSON and PNG pair to this Font. |

In **Project Settings > Fonts**, **Default Font** is used when a requested font is unavailable, and **Global Fallback** picks the generic family (such as sans-serif) used last.

## Notes

- 2D Text and 2D Rich Text draw with **Renderer** set to **Bitmap** or **MSDF**. **MSDF** is available only when the Font has both the MSDF JSON and the MSDF Atlas.
- 3D Text uses the Font's typeface data. Without it, the text uses a built-in typeface with basic ASCII characters.

## Related

- [Importing](../editor/importing.md)
- [2D Text](../components/2d-text.md)
- [2D Rich Text](../components/2d-rich-text.md)
- [3D Text](../components/text-3d.md)
