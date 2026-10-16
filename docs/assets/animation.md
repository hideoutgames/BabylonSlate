# Animation

One animation clip from an imported model, previewed on that model.

## Import

Animations are not created from **New Asset**. Importing a GLB or glTF model creates one Animation for each clip in the file. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**. Both are read-only.

- **Preview** plays the clip on its model. Turn on **Show Bones** to see the bones instead of the mesh. If the mesh cannot load, it shows **No Mesh**.
- The **Inspector** shows the clip's details.

## Settings

| Setting | Description |
| --- | --- |
| Clip Name | The clip's name in the file. |
| Model | The Model the clip came from. |
| Skeleton | The [Skeleton](skeleton.md) the clip plays on. |
| Duration | The clip's length in milliseconds, when known. |

## Retarget

To play a clip on a different character, select Animation assets in the **Content Browser**, choose **Retarget…** and pick the target Skeleton. Haptic adds a retargeted copy of each clip to the current folder. Clips with no matching bones on the target are reported in **Retarget Failed**.

## Use it

Play clips in a game with an [Animation Graph](animation-graph.md) and the [Animation Graph component](../components/animation-graph.md).

## Related

- [Models](../graphics/models.md)
- [Skeleton](skeleton.md)
