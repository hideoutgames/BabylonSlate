# Animation

One animation clip from an imported model, previewed on that model.

## Import

Animations are not created from **New Asset**. Importing a GLB or glTF model creates one Animation for each clip in the file. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** plays the clip on its model at its **Duration**, drawn with the Model's slot Materials. Turn on **Show Bones** to see the bones instead of the mesh. If the mesh cannot load, it shows **No Mesh**.
- The **Inspector** shows the clip's details. Only **Duration** can be changed.

## Settings

| Setting | Description |
| --- | --- |
| Clip Name | The clip's name in the file. |
| Model | The Model the clip came from. |
| Skeleton | The [Skeleton](skeleton.md) the clip plays on. |
| Duration | How long one pass of the clip takes, in milliseconds. It starts at the clip's length in the file. A shorter Duration plays the clip faster everywhere it is used, a longer one slower; an [Animation Graph](animation-graph.md) state's **Speed** scales it further. **Reset** restores the clip's length. Shown when the clip's length is known. |

## Retarget

To play a clip on a different character, select Animation assets in the **Content Browser**, choose **Retarget…** and pick the target Skeleton. Haptic adds a retargeted copy of each clip to the current folder, with the same Duration. Clips with no matching bones on the target are reported in **Retarget Failed**.

## Use it

Play clips in a game with an [Animation Graph](animation-graph.md) and the [Animation Graph component](../components/animation-graph.md).

## Related

- [Models](../graphics/models.md)
- [Skeleton](skeleton.md)
