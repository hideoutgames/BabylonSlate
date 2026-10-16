# 2D Text

Draws text from a Font on a Scene Layer.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Text**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Text**.

Type the words in the **Text** field below the other settings.

## Settings

| Setting | Description |
| --- | --- |
| Font | The [Font](../assets/font.md) to use. Empty uses the default font. |
| Text Material | A Material with the **Text** domain. Its [Text Output](../scripting/material/text-output.md) colour multiplies the letters' colour while the letter shapes stay intact. |
| Material UV | How the Material's UVs map: Text Box spreads 0 to 1 across the whole text box (default). Each Glyph repeats 0 to 1 on every letter. |
| Renderer | Bitmap (default) or MSDF. MSDF stays sharp at any scale but needs a Font with an MSDF atlas. The option is unavailable until the Font has one. |
| Size | Letter size in pixels, from 1 to 256. Default 32. |
| Color | Colour of the letters. Default white. |
| Outline | Outline width, from 0 to 16. 0 draws no outline. Default 0. |
| Outline Color | Colour of the outline. Default black. |
| Alignment | Left (default), Center or Right, against the text box. |
| Vertical Alignment | Top, Center (default) or Bottom, against the text box. |
| Wrap Width | Width of the text box in pixels. Text wraps at this width. 0 breaks lines only at line breaks. Default 200. |
| Wrap Height | Height of the text box in pixels. Extra lines can overflow the top and bottom. Default 64. |
| Bold, Italic, Underline | Letter styles. Default off. With MSDF, the atlas has one weight and style, so Bold and Italic are approximations. |
| Hit Test | Ignore (default) lets taps pass through. Block takes the tap and stops it. Pass Through takes it and lets it continue to what is behind. |

## Notes

- Scene Layers only.
- Size, Wrap Width and Wrap Height are in pixels. Haptic divides them by **Pixels Per Unit** (**Project Settings > Game > 2D**, default 100) to get layer units.
- Dragging the handles of the box in the viewport changes Wrap Width and Wrap Height. It does not scale the letters.
- Pointer events need a [2D Button](2d-button.md) on the same actor.
- Change the text from a graph with **Set Text**. [Event On Text Changed](../scripting/class/event-on-text-changed.md) runs when it changes.
- The component also has **Opacity** and **Tint** variables. Animate them with [Tween 2D Opacity](../scripting/class/tween-2d-opacity.md) and [Tween 2D Tint](../scripting/class/tween-2d-tint.md), or use [Tween Text Color](../scripting/class/tween-text-color.md), [Tween Text Font Size](../scripting/class/tween-text-font-size.md), [Tween Text Outline](../scripting/class/tween-text-outline.md), [Tween Text Outline Color](../scripting/class/tween-text-outline-color.md) and [Tween Text Wrap Size](../scripting/class/tween-text-wrap-size.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Font](../assets/font.md)
- [2D Rich Text](2d-rich-text.md)
