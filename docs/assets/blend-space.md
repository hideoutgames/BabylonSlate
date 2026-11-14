# Blend Space

Animations on one [Skeleton](skeleton.md), placed on one or two axes such as Speed and Direction. A [Blend Space Player](../scripting/animation/blend-space-player.md) in an [Animation Graph](animation-graph.md) blends the Animations nearest its input, so a character eases from idle to walk to run, or turns while it walks.

## Create

- In the **Content Browser**, choose **New Asset > Animation > Blend Space** and pick its **Skeleton** in the New Asset dialog.
- Or right-click a Skeleton or a Model and choose **Create Blend Space**. It is set to that Skeleton.

## Editor

Double-tap a Blend Space to open it. Its windows:

- **Grid**: the axes, with each sample as a diamond. Drag a sample to move it; it snaps to the grid. Select one and press Delete to remove it. A two-axis space shows the triangles its weights come from. The red cross is the preview point: click or drag on the Grid to move it (on touch, tap where it should go or drag the cross). The corner shows the point and the heaviest samples there.
- **Animations**: the Animations on the Blend Space's Skeleton. Drag one onto the Grid to add it there, or tap its **+** to add it at the preview point. The count beside an Animation says how often it is placed.
- **Preview**: a Model on the Skeleton playing the blend at the preview point, as a game would, with **Play** or **Pause**, **Speed**, the **Preview Model** list and **Bones**. The bar ends with the cycle's position and length.
- **Inspector**: the **Skeleton**, the **Axes** (one or two), each axis's settings and the selected sample's.

## Settings

**Axis**

| Setting | Description |
| --- | --- |
| Name | What drives the axis, shown on the Grid, such as Speed. |
| Minimum, Maximum | The axis's range. An input outside it clamps to the nearest end, or wraps with **Wrap**. |
| Grid Divisions | Grid cells across the range. Samples snap to the grid lines. |
| Smoothing Time | How long a change of the input takes to settle, in seconds. 0 follows it at once. |
| Wrap | Joins the ends, so an input past one comes in at the other, as for an angle from −180 to 180. Place the same Animation at both ends. |

**Sample**

| Setting | Description |
| --- | --- |
| Animation | The Animation the sample plays. Only Animations on the Blend Space's Skeleton are offered. |
| X, Y | Its position, named after the axes. |
| Rate Scale | Plays this sample faster or slower; 1 plays it at its Animation's **Duration**. |

The Preview's Model is saved with the Blend Space and is used only in the editor.

## How it blends

- With one axis, the two samples either side of the input play, weighted by how close each is.
- With two axes, the samples are joined into triangles, and the three corners of the triangle holding the input play, weighted by how close each is. Outside every triangle the input moves to the nearest edge.
- Every sample plays at the same point of its cycle. One cycle lasts the samples' lengths (each over its **Rate Scale**) averaged by their weights, so feet stay in step as the blend changes.

## Related

- [Blend Space Player](../scripting/animation/blend-space-player.md)
- [Sprite Blend Space](sprite-blend-space.md), its 2D counterpart
- [Animation Graph](animation-graph.md)
- [Animation](animation.md)
- [Skeleton](skeleton.md)
