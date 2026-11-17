# 2D Rich Text

Draws text with inline formatting, images and animated letters, and can reveal it one character at a time.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Rich Text**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Rich Text**.

Type the words and tags in the **Text** field below the other settings. A new component starts with an example.

## Settings

Rich Text has every setting of [2D Text](2d-text.md), plus the settings that reveal the text. The Font, Size, Color, Outline, Bold, Italic and Underline settings are the defaults that tags then override.

| Setting | Description |
| --- | --- |
| Appear Modes | A list of Fade, Scale, Slide and your own [custom modes](#custom-appear-modes-and-effects), each at most once. Custom modes are listed as their Class name followed by **(Custom)**. Instant replaces the rest. An empty list is Off, and the text shows at once. Default Off. |
| Appear Start | Fully Revealed (default), Hidden or Play On Start. Sets the state at the start of Play. The editor always shows the full text. |
| Appear Transition | The curve each character follows, such as Linear, Cubic Out (default) or Bounce Out, or Instant. |
| Time Between Characters | Seconds between one character starting and the next. 0 starts them together. Default 0.1. |
| Character Reveal Duration | Seconds each character takes to appear. Default 0.3. |
| Appear Sound | Plays a sound while the text appears. Off by default. The three settings below show only while it is on. |
| Sound | The [Audio](../assets/audio.md) asset to play. |
| Sound Play | When the sound plays: Every Letter (default), Every Other Letter, Every Third Letter, Every Fourth Letter, Once or Loop Until Finished. |
| Sound Offset | Seconds to wait after a letter starts appearing before its sound plays, for syncing the sound with the letter. Default 0. |

The transition, timing and sound settings are greyed out when they do not apply, such as with Appear Modes Off. They keep their values.

## Appear sound

- The letter options count visible characters and inline images, and skip spaces. Letters that start at the same moment share one sound.
- **Once** plays the sound a single time when the reveal starts, after **Sound Offset**.
- **Loop Until Finished** starts the sound after **Sound Offset** and stops it when the last character has appeared.
- The sound plays when the text reveals forwards, from **Play On Start**, **Trigger Appear** or **Play**. **Play Reverse** is silent and stops a looping sound.
- A reveal that continues from part-way plays only the sounds of the letters still to appear.

## Tags

Tags use square brackets and can nest. Close them with the same name, such as `[/b]`. A tag left open runs to the end of the text, and an unknown tag shows as plain text.

| Tag | Effect |
| --- | --- |
| `[b]`, `[i]`, `[u]` | Bold, italic, underline. |
| `[color=red]` | Colour, by name (red, orange, yellow, green, blue, purple, white, black and other basic colours) or hex such as `#ff8800`. |
| `[size=48]` | Letter size in pixels. With a pixel font, it rounds to the nearest whole multiple of the font's Pixel Size. |
| `[outline=2]`, `[outline-color=black]` | Outline width and colour. `[outline]` alone keeps the **Outline** setting, or uses 1 when that is 0. |
| `[img=… size=32]` | An inline image from a Texture. In the **Content Browser**, choose **Copy Asset Reference** on the Texture and paste the value after `img=`. Size is optional. |
| `[shake=1]` | Jitters each letter. The number is the strength. |
| `[wave=2]` | Moves letters up and down in a wave. The number is the speed. Add `intensity=2` to change the height. |
| `[hover=1]` | Bobs each letter up and down. The number is the strength. |
| `[rotate=45]` | Rocks each letter back and forth by up to that many degrees. |
| `[fx=ClassName strength=2]` | Runs your own [Decorator Effect](#custom-appear-modes-and-effects) Class on the letters inside. Strength is optional and defaults to 1. |

## Custom appear modes and effects

You can script how letters appear and animate with two kinds of [Class](../scripting/classes.md). Both receive letters as **RichText2DLetter** objects.

| Parent class | Use | Event |
| --- | --- | --- |
| **RichText2DAppearMode** | A new way for letters to appear. Choose it in **Appear Modes**; it combines with the built-in modes and other custom modes. | [Event On Letter Appear](../scripting/class/event-on-letter-appear.md), once per letter with its **Alpha** from 0 to 1. |
| **RichText2DDecoratorEffect** | A continuous effect like Shake or Rotate. Apply it with the `[fx=ClassName]` tag. | [Event On Decorate Letters](../scripting/class/event-on-decorate-letters.md), every tick with the tagged letters and **Delta Seconds**. |

Read and change a letter with **Get** and **Set** nodes on these variables:

| Letter variable | Description |
| --- | --- |
| Index | Position of the letter in the text, starting at 0. Tags do not count, and an inline image counts as one. Read-only. |
| Character | The letter itself; empty for an inline image. Read-only. |
| Offset | Movement from the letter's place, in pixels. Positive Y is up. |
| Scale | Size multiplier for width and height. 1 is the normal size. |
| Rotation | Turn in degrees, added to the letter's own. |
| Opacity | From 0 (invisible) to 1 (fully visible), multiplied with the built-in Fade. |

- Appear modes run first, each from the letter at rest; decorator effects then change what the modes left.
- A letter stays hidden until its reveal starts, as with the built-in modes.
- Custom modes and effects run in Play only. The editor shows the letters at rest.
- A tag that names a Class that does not exist, or one with another parent, does nothing.

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
