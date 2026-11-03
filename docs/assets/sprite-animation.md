# Sprite Animation

A 2D clip, played by an Animation Graph. Its frames are Textures or Sprites, or the cells of one sprite sheet.

## Create

- In the **Content Browser**, select one or more Textures and Sprites (you can mix them), then right-click or long-press one and choose **Create Sprite Animation**. The new animation has one frame per asset in name order (`Run_2` before `Run_10`), sits beside the first one and opens. It is named after the first asset without its trailing number: `Run_1` makes `Run`.
- Or choose **New Asset > Animation > Sprite Animation**.

Import each image as a Texture first. See [Importing](../editor/importing.md).

## Editor

Double-tap a Sprite Animation to open it.

- **Preview**: **Play** or **Pause** the clip, turn **Loop** on or off, and drag the scrubber. The current frame and time sit next to the scrubber. A strip of frames sits below; tap a frame to select it. Every frame's image loads once when the animation opens, so playback never waits for an image.
- On a frame that is not from a Sprite, drag the collision box or its handles to change the frame's **Collision**.
- **Inspector**: an **Animation** section for the whole clip, a **Sheet** section in Sheet mode, and a section for the selected frame, titled **Frame 1**, **Frame 2** and so on. The header shows the frame count and total length.
- **Add Frame** adds a frame after the others. The remove button deletes the selected one; the last frame cannot be removed.

## Frames and sheets

**Source** chooses where the frames come from.

| Source | Frames |
| --- | --- |
| Frames | Each frame shows an **Image**: a Texture, or a Sprite. |
| Sheet | Every frame is a cell of one Texture, cut on a grid like a [Tileset](tileset.md). |

### Sprite frames

A frame whose **Image** is a [Sprite](sprite.md) uses that Sprite's Texture, pivot and collision box. Its **Pivot** and **Collision** show the Sprite's values and cannot be changed here; choose **Open Sprite** to edit them in the Sprite. A change to the Sprite shows in every animation that uses it.

### Sheet mode

1. Set **Source** to **Sheet**. The first Texture frame becomes the sheet's **Texture**, and each frame becomes a cell in turn.
2. Set **Cell Width** and **Cell Height** to the size of one frame on the sheet, and **Margin** and **Spacing** if the sheet has them. The **Sheet** header shows how many cells the Texture holds.
3. Choose each frame's **Cell**, or choose **Use All Cells** to make every cell a frame, in order.

Cells are numbered from 1, row by row from the top-left of the image. In the **Preview**, choose **Sheet** to see the whole Texture with its grid: tap a cell to show it in the selected frame, or drag across cells to make them the frames, in reading order. Choose **Frame** to go back to the frame view.

Switching **Source** back to **Frames** keeps each frame's Texture or Sprite, and switching to **Sheet** again keeps the sheet settings.

## Settings

| Setting | Description |
| --- | --- |
| Source | **Frames** or **Sheet**. See [Frames and sheets](#frames-and-sheets). |
| Frame Duration | Length of every frame in milliseconds. Default 100. |
| Texture | Sheet mode: the sprite sheet. |
| Cell Width, Cell Height | Sheet mode: size of one cell in pixels. Default 32. |
| Margin | Sheet mode: border around the sheet, in pixels. |
| Spacing | Sheet mode: gap between cells, in pixels. |
| Image | Frames mode: the selected frame's Texture or Sprite. |
| Cell | Sheet mode: the selected frame's cell. |
| Frame Duration Override | Turn on to give the selected frame its own **Frame Duration**. |
| Pivot | The point of the frame that sits at the actor's position, as fractions of the frame. 0.5, 0.5 is the centre. From the Sprite for a Sprite frame. |
| Collision | The frame's collision box as fractions of the frame: X, Y, W and H. From the Sprite for a Sprite frame. |

A frame's size in the scene is its image's size in pixels (the whole Texture, the Sprite's Texture, or one cell) divided by the project's pixels per unit.

## Notes

- A Sprite Animation plays only from an [Animation Graph](animation-graph.md). Set a state's **Clip Kind** to **Sprite** and **Clip Asset** to the Sprite Animation.
- The actor also needs a [Sprite component](../components/sprite.md). It shows the component's Sprite until the graph plays its first frame.
- While the clip plays, a **Box 2D** [Collider](../components/collider.md) follows each frame's collision box.

## Related

- [Sprites](../2d/sprites.md)
- [Sprite](sprite.md)
- [Tileset](tileset.md)
- [Animation Graph](animation-graph.md)
- [Animation Graph component](../components/animation-graph.md)
- [Texture](texture.md)
