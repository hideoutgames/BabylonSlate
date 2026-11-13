# Animation

One animation clip from an imported model, previewed on that model.

## Import

Animations are not created from **New Asset**. Importing a GLB or glTF model creates one Animation for each clip in the file. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** plays the clip on its model at its **Duration**, drawn with the Model's slot Materials. Turn on **Show Bones** to see the bones instead of the mesh. A clip from a file with no mesh (an animation-only file) always shows its bones. If the Model's file is missing, it shows **No Mesh**; if its file cannot be read, it shows **Failed to Read Mesh** with the reason.
- The **Inspector** shows the clip's details. Only **Duration** can be changed.

**Preview controls**

| Control | Description |
| --- | --- |
| Play / Pause | Starts or stops the clip. It plays while the Preview is visible. |
| Step | Pauses and moves one frame on, wrapping to the start after the last. |
| Restart | Returns to the start. |
| Loop | Repeats the clip. Off, the clip stops on its last frame, and **Play** starts it again. Only the Preview changes. |
| Speed | 0.25× to 2×. |
| Show Bones | Shows the bones instead of the mesh. |

The bar under the Preview shows the frame and the time in ms, out of the Duration. Drag it to scrub: the Preview pauses and holds the pose under the playhead.

## Settings

| Setting | Description |
| --- | --- |
| Clip Name | The clip's name in the file. |
| Model | The Model the clip came from. |
| Skeleton | The [Skeleton](skeleton.md) the clip plays on. |
| Duration | How long one pass of the clip takes, in milliseconds. It starts at the clip's length in the file. A shorter Duration plays the clip faster everywhere it is used, a longer one slower; an [Animation Graph](animation-graph.md) state's **Speed** scales it further. **Reset** restores the clip's length. Shown when the clip's length is known. |

## Shared Skeletons

Every Model on a [Skeleton](skeleton.md) plays every Animation on it, whichever file the clip came from. Characters that share a rig and a separate animation file all join one Skeleton when you import them, so their clips need no retargeting.

## Retarget

To play a clip on a character with another Skeleton, select Animation assets in the **Content Browser**, choose **Retarget…** and pick the target Skeleton. Haptic adds a retargeted copy of each clip to the current folder, with the same Duration. Clips with no matching bones on the target are reported in **Retarget Failed**.

## Use it

Play clips in a game with an [Animation Graph](animation-graph.md) and the [Animation Graph component](../components/animation-graph.md).

## Related

- [Models](../graphics/models.md)
- [Skeleton](skeleton.md)
