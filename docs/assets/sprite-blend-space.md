# Sprite Blend Space

[Sprite Animations](sprite-animation.md) placed on one or two axes, such as Direction or Speed. A [Sprite Blend Space Player](../scripting/animation/sprite-blend-space-player.md) in a 2D [Animation Graph](animation-graph.md) plays the one nearest its input, so a character faces the way it walks or steps from idle to walk to run. Frames cannot blend, so one sample plays at a time.

## Create

In the **Content Browser**, choose **New Asset > 2D > Sprite Blend Space**. It starts with one wrapping **Direction** axis from −180 to 180.

## Editor

Double-tap a Sprite Blend Space to open it. It has the same windows as a [Blend Space](blend-space.md#editor):

- **Grid**: the axes and the samples. Drag a sample to move it; it snaps to the grid. The red cross is the preview point, and the corner names the sample playing there.
- **Animations**: every Sprite Animation. Drag one onto the Grid, or tap its **+** to add it at the preview point.
- **Preview**: the frames the preview point plays, as a game would, with **Play** or **Pause** and **Speed**.
- **Inspector**: **Hysteresis** and **Keep Time**, the **Axes** (one or two), each axis's settings and the selected sample's.

## Settings

| Setting | Description |
| --- | --- |
| Hysteresis | How much nearer another sample must be, as a fraction of the axis, before it takes over. It stops the frames flickering when the input sits on a boundary. 0 always plays the nearest. |
| Keep Time | When the sample changes, the next one goes on from the same point of its cycle instead of starting over, so a walk keeps its step as it turns. |

Each axis has the [Blend Space axis settings](blend-space.md#settings): Name, Minimum and Maximum, Grid Divisions, Smoothing Time and Wrap. Each sample has its **Sprite Animation**, its position and a **Rate Scale**: 1 plays it at its Sprite Animation's length.

For eight directions, use one wrapping Direction axis with a sample every 45°, and the same animation at both −180 and 180.

## Related

- [Sprite Blend Space Player](../scripting/animation/sprite-blend-space-player.md)
- [Blend Space](blend-space.md)
- [Sprite Animation](sprite-animation.md)
- [Animation Graph](animation-graph.md)
