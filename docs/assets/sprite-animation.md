# Sprite Animation

A 2D clip made of Texture frames, played by an Animation Graph.

## Create

In the **Content Browser**, choose **New Asset > Animation > Sprite Animation**. Import each frame as its own Texture first. See [Importing](../editor/importing.md).

## Editor

Double-tap a Sprite Animation to open it.

- **Preview**: **Play** or **Pause** the clip, turn **Loop** on or off, and drag the scrubber. A strip of frames sits below; tap a frame to select it.
- **Inspector**: an **Animation** section for the whole clip, and a section for the selected frame, titled **Frame 1**, **Frame 2** and so on. The header shows the frame count and total length.
- **Add Frame** adds a frame after the others. The remove button deletes the selected one; the last frame cannot be removed.

## Settings

| Setting | Description |
| --- | --- |
| Frame Duration | Length of every frame in milliseconds. Default 100. |
| Texture | The selected frame's image. |
| Frame Duration Override | Turn on to give the selected frame its own **Frame Duration**. |
| Pivot | The point of the frame that sits at the actor's position, as fractions of the image. 0.5, 0.5 is the centre. |
| Collision | The frame's collision box as fractions of the image: X, Y, W and H. |

## Notes

- A Sprite Animation plays only from an [Animation Graph](animation-graph.md). Set a state's **Clip Kind** to **Sprite** and **Clip Asset** to the Sprite Animation.
- The actor also needs a [Sprite component](../components/sprite.md).
- While the clip plays, a **Box 2D** [Collider](../components/collider.md) follows each frame's collision box.

## Related

- [Sprites](../2d/sprites.md)
- [Sprite](sprite.md)
- [Animation Graph](animation-graph.md)
- [Animation Graph component](../components/animation-graph.md)
- [Texture](texture.md)
