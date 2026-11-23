# 2D Rich Text

Draws text with inline formatting, images and animated letters, and can reveal it one character at a time.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Rich Text**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Rich Text**.

Type the words and tags in the **Text** field below the other settings. For the list of tags, open the text in its own tab with the button next to **Text**: the tab shows every tag above the text and inserts the one you pick ([Long text and code](../start/editor-tour.md#long-text-and-code)). A new component starts with an example of [tags](#tags) and letter effects. It has no image: add one with `[img=…]` and a Texture of your own.

## Settings

Rich Text has every setting of [2D Text](2d-text.md), plus the settings that reveal the text. The Font, Size, Color, Outline, Bold, Italic and Underline settings are the defaults that tags then override.

| Setting | Description |
| --- | --- |
| Appear Modes | A list of Fade, Scale, Slide and your own [custom modes](#custom-appear-modes-and-effects), each at most once. Custom modes are listed as their Class name followed by **(Custom)**. Instant replaces the rest. An empty list is Off, and the text shows at once. Default Off. |
| Appear Start | Fully Revealed (default), Hidden or Play On Start. Sets the state at the start of Play. The editor always shows the full text. |
| Appear Transition | The curve each character follows, such as Linear, Cubic Out (default) or Bounce Out, or Instant. Your [custom easing curves](../scripting/curves-and-ranges.md#custom-easing-curves) follow, listed as their Class name followed by **(Custom)**. |
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

## Reveal events

Add these from **Add Event** in the **Class** window of the actor that has the component. Each lists the component by name, such as **Event On Appear Finished (Rich Text)**.

| Event | Runs |
| --- | --- |
| [Event On Letter Shown](../scripting/class/event-on-letter-shown.md) | Once per letter as it starts appearing on a forward reveal, with its **Index** and **Character**. It runs at the same moments as **Every Letter** of the appear sound with no offset. |
| [Event On Appear Finished](../scripting/class/event-on-appear-finished.md) | Each time a forward reveal reaches fully revealed. |
| [Event On Disappear Finished](../scripting/class/event-on-disappear-finished.md) | Each time **Play Reverse** reaches fully hidden. |

- **Play Reverse** never runs Event On Letter Shown, and a reveal that continues from part-way runs it only for the letters that start at or after that point.
- The finish events run only when a play gets the text there: not when it was already at that end, and not for the state the text starts in.
- With **Appear Modes** Off the text appears and hides at once: the finish events still run, and no letter is shown one by one.
- The events run after the reveal and the letters have moved for that tick. One that **Play** or **Play Reverse** causes at once runs at the start of the next tick.

## Tags

Tags use square brackets and can nest. Close them with the same name, such as `[/b]`. A tag left open runs to the end of the text, and an unknown tag shows as plain text. You can also make [tags of your own](#custom-tags).

| Tag | Effect |
| --- | --- |
| `[b]`, `[i]`, `[u]` | Bold, italic, underline. |
| `[color=red]` | Colour, by name (red, orange, yellow, green, blue, purple, white, black and other basic colours) or hex such as `#ff8800`. |
| `[size=48]` | Letter size in pixels. With a pixel font, it rounds to the nearest whole multiple of the font's Pixel Size. |
| `[outline=2]`, `[outline-color=black]` | Outline width and colour. `[outline]` alone keeps the **Outline** setting, or uses 1 when that is 0. |
| `[img=… size=32]` | An inline image from a Texture. In the **Content Browser**, choose **Copy Asset Reference** on the Texture and paste the value after `img=`. Size is optional. If no asset has that reference, Play does not start and names the Actor and component that use it ([Play stops on a missing asset](../start/editor-tour.md#when-play-cannot-start)). |
| `[shake=1]` | Jitters each letter. The number is the strength. |
| `[wave=2]` | Moves letters up and down in a wave. The number is the speed. Add `intensity=2` to change the height. |
| `[hover=1]` | Bobs each letter up and down. The number is the strength. |
| `[rotate=45]` | Rocks each letter back and forth by up to that many degrees. |
| `[fx=ClassName strength=2]` | Runs your own [Letter Effect](#custom-appear-modes-and-effects) Class on the letters inside. Strength is optional and defaults to 1. Add the Class's own [keywords](#tag-keywords), such as `speed=3`. |

## Custom appear modes and effects

You can script how letters appear and animate with two kinds of [Class](../scripting/classes.md). Both receive letters as **RichText2DLetter** objects.

| Parent class | Use | Event |
| --- | --- | --- |
| **RichText2DAppearMode** | A new way for letters to appear. Choose it in **Appear Modes**; it combines with the built-in modes and other custom modes. | [Event On Letter Appear](../scripting/class/event-on-letter-appear.md), once per letter with its **Alpha** from 0 to 1. |
| **RichText2DLetterEffect** | A continuous effect like Shake or Rotate. Apply it with the `[fx=ClassName]` tag. | [Event On Update Letters](../scripting/class/event-on-update-letters.md), every tick with the tagged letters and **Delta Seconds**. It can read its own [tag keywords](#tag-keywords). |

Read and change a letter with **Get** and **Set** nodes on these variables:

| Letter variable | Description |
| --- | --- |
| Index | Position of the letter in the text, starting at 0. Tags do not count, and an inline image counts as one. Read-only. |
| Character | The letter itself; empty for an inline image. Read-only. |
| Offset | Movement from the letter's place, in pixels. Positive Y is up. |
| Scale | Size multiplier for width and height. 1 is the normal size. |
| Rotation | Turn in degrees, added to the letter's own. |
| Opacity | From 0 (invisible) to 1 (fully visible), multiplied with the built-in Fade. |
| Tint | A colour the letter is multiplied by, on top of the component's **Tint**. White leaves it unchanged. Only red, green and blue are used, each from 0 to 1; use Opacity for transparency. |

- Appear modes run first, each from the letter at rest; letter effects then change what the modes left.
- A letter stays hidden until its reveal starts, as with the built-in modes.
- Custom modes and effects run in Play only. The editor shows the letters at rest.
- A tag that names a Class that does not exist, or one with another parent, does nothing.
- Tint shows on every kind of letter: font glyphs, inline images and texts with a **Text Material**. An underline takes the pose and Tint of the letter it starts under; with **Appear Modes** on, each letter has its own piece of underline.

## Tag keywords

A Letter Effect can take settings of its own from its tag, such as `[fx=Wave speed=2 height=4]…[/fx]`.

1. In the Class, tap **+** next to **Functions** in the **Class** window and choose **Get Keys**, marked **RichText2DLetterEffect**. It overrides the function every Letter Effect has.
2. Return the keywords the Class reads from its **Keys** output, for example a **Make Array** of the strings `speed` and `height`.
3. In [Event On Update Letters](../scripting/class/event-on-update-letters.md), read each value with [Get Tag Value](../scripting/class/get-tag-value.md). Values are text: turn them into numbers with a node such as [Parse Float](../scripting/class/parse-float.md).

- Keywords are not case-sensitive. A keyword the tag does not set reads as an empty string.
- Letters whose tags give different values of your keywords run in separate Event On Update Letters calls, so each call reads one set of values. Keywords the Class does not list are ignored and do not separate letters.
- **Get Keys** runs once when the text is built, and again only when the text or its Appear Modes change.
- **Strength** stays a pin of the event; you can also list `strength` as a keyword to read it as text.

## Custom tags

A **Rich Text Decorator** is a [Class](../scripting/classes.md) that adds a tag of its own and decides what the tag turns into. For example, `[player]` can show the player's name, and `[item=sword]Sword[/item]` can become `[img=… size=20] [color=orange]Sword[/color]`.

1. Create a Class whose parent is **RichText2DDecorator**.
2. In the **Class** window, tap **+** next to **Functions** and choose **Get Tag**, marked **RichText2DDecorator**. Return the tag's name from its **Tag** output, such as `item`.
3. Tap **+** again and choose **Decorate**. Build the markup that replaces the tag and return it from its **Markup** output.
4. Write the tag in any 2D Rich Text, such as `[item=sword rarity=epic]Sword[/item]`.

**Decorate** receives:

| Input | Type | Description |
| --- | --- | --- |
| Value | String | What follows `=` in the opening tag, such as `sword`. Empty when the tag has none. |
| Content | String | The text between the opening tag and its closing tag, exactly as written, tags included. Empty when the tag has no closing tag. |
| Component | 2DRichTextComponent Reference | The 2D Rich Text being built, for reading its actor or other values. |

- **Markup** replaces the whole tag, from the opening tag through its closing tag, or just the opening tag when it has none. It can use any tag, including other custom tags and tags in **Content**.
- Read the tag's other keywords with [Get Tag Value](../scripting/class/get-tag-value.md), such as `rarity` for `rarity=epic`. Every keyword is available; no **Get Keys** is needed.
- Tag names are not case-sensitive. They start with a letter and use letters, numbers and hyphens. A built-in tag name, such as `color` or `fx`, cannot be used.
- When two Classes return the same tag, the one whose name comes first alphabetically handles it, and the Output Log shows a warning naming both.
- Tags of one name pair like brackets: in `[q]a[q]b[/q]c[/q]` the inner pair closes first. A tag without a closing tag replaces only itself.
- Custom tags expand up to eight levels deep: markup that keeps producing custom tags stops there and shows the rest as written. Very long results stop being expanded at 100 000 characters.
- When **Decorate** returns nothing, fails or waits, the tag shows as written.
- The tag is turned into markup when the text first appears, whenever its **Text** changes and when scripts reload, never every tick. Call **Refresh Text** on the component to run the Decorators again, for example after the player's name changes. Nothing is redrawn when the result is the same.
- **Text**, **Set Text** and [Event On Text Changed](../scripting/class/event-on-text-changed.md) keep the text as you wrote it, tags included. The reveal, its sound and letter effects follow the text as shown.
- Decorators run in Play only. The editor shows custom tags as written, like any unknown tag.
- Get Tag runs once each time scripts load. One object of each Decorator Class serves every text.

## Notes

- Scene Layers only.
- Tags use no reveal time. Each inline image counts as one character. The whole text decides the wrapping, so text does not reflow as it appears.
- Control the reveal from a graph. **Trigger Appear** restarts from hidden, **Play** continues toward fully revealed and **Play Reverse** continues toward hidden. The read-only **Appear Progress** variable runs from 0 to 1, and **Is Revealed** is true at 1.
- **Refresh Text** runs the [custom tags](#custom-tags) of the text again.
- Letter effects pause while the game is paused.
- **Set Text** and [Event On Text Changed](../scripting/class/event-on-text-changed.md) work as on 2D Text.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Text](2d-text.md)
- [Font](../assets/font.md)
