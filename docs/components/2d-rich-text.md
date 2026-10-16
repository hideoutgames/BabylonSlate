# 2D Rich Text

Draws text with inline formatting, images and animated letters, and can reveal it one character at a time.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Rich Text**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Rich Text**.

Type the words and tags in the **Text** field below the other settings. A new component starts with an example.

## Settings

Rich Text has every setting of [2D Text](2d-text.md), plus the settings that reveal the text. The Font, Size, Color, Outline, Bold, Italic and Underline settings are the defaults that tags then override.

| Setting | Description |
| --- | --- |
| Appear Modes | A list of Fade, Scale and Slide, each at most once. Instant replaces the rest. An empty list is Off, and the text shows at once. Default Off. |
| Appear Start | Fully Revealed (default), Hidden or Play On Start. Sets the state at the start of Play. The editor always shows the full text. |
| Appear Transition | The curve each character follows, such as Linear, Cubic Out (default) or Bounce Out, or Instant. |
| Time Between Characters | Seconds between one character starting and the next. 0 starts them together. Default 0.1. |
| Character Reveal Duration | Seconds each character takes to appear. Default 0.3. |

The transition and timing settings are greyed out when they do not apply, such as with Appear Modes Off. They keep their values.

## Tags

Tags use square brackets and can nest. Close them with the same name, such as `[/b]`. A tag left open runs to the end of the text, and an unknown tag shows as plain text.

| Tag | Effect |
| --- | --- |
| `[b]`, `[i]`, `[u]` | Bold, italic, underline. |
| `[color=red]` | Colour, by name (red, orange, yellow, green, blue, purple, white, black and other basic colours) or hex such as `#ff8800`. |
| `[size=48]` | Letter size in pixels. |
| `[outline=2]`, `[outline-color=black]` | Outline width and colour. `[outline]` alone keeps the **Outline** setting, or uses 1 when that is 0. |
| `[img=… size=32]` | An inline image from a Texture. In the **Content Browser**, choose **Copy Asset Reference** on the Texture and paste the value after `img=`. Size is optional. |
| `[shake=1]` | Jitters each letter. The number is the strength. |
| `[wave=2]` | Moves letters up and down in a wave. The number is the speed. Add `intensity=2` to change the height. |
| `[hover=1]` | Bobs each letter up and down. The number is the strength. |
| `[rotate=45]` | Rocks each letter back and forth by up to that many degrees. |

## Notes

- Scene Layers only.
- Tags use no reveal time. Each inline image counts as one character. The whole text decides the wrapping, so text does not reflow as it appears.
- Control the reveal from a graph. **Trigger Appear** restarts from hidden, **Play** continues toward fully revealed and **Play Reverse** continues toward hidden. The read-only **Appear Progress** variable runs from 0 to 1, and **Is Revealed** is true at 1.
- Letter effects pause while the game is paused.
- **Set Text** and [Event On Text Changed](../scripting/class/event-on-text-changed.md) work as on 2D Text.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Text](2d-text.md)
- [Font](../assets/font.md)
