# Animation

One animation clip from an imported model, previewed on that model.

## Import

Animations are not created from **New Asset**. Importing a GLB or glTF model creates one Animation for each clip in the file. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview**, a **Timeline** below it and an **Inspector**.

- **Preview** plays the clip on its model at its **Duration**, drawn with the Model's slot Materials. Turn on **Show Bones** to see the bones instead of the mesh. A clip from a file with no mesh (an animation-only file) always shows its bones. If the Model's file is missing, it shows **No Mesh**; if its file cannot be read, it shows **Failed to Read Mesh** with the reason.
- **Timeline** shows the clip's [Animation Events](#animation-events) along one pass: single events on the **Events** row, and each window on a row of its own from its begin to its end. Drag the ruler to scrub the Preview. **Add Event** and **Add Window** place a new one at the playhead. Drag a key to move it; drag a window's end key alone to change its Duration. Selected keys open their events in the Inspector.
- The **Inspector** shows the clip's details and its **Events**. Of the details, only **Duration** and **Additive** can be changed.

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
| Additive | Whether the clip is [additive](#additive-animations), and what its change is relative to. **None** by default. |
| Base Animation | With **Relative To Animation**: the Animation, on the same Skeleton, whose pose the change is from. |
| Base Time | With **Relative To Animation**: the time into the Base Animation's Duration of that pose, in milliseconds. |

## Animation events

Animation Events are named moments in the clip, such as a footstep or the window in which a sword swing can hit. An [Animation Graph](animation-graph.md#animation-events) playing the clip fires them, and each name runs its own event node in the graph's Animation Object.

Add one on the **Timeline**, or tap **Add Event** under **Events** in the **Inspector**; both place it at the Preview's playhead. Then set:

| Setting | Description |
| --- | --- |
| Name | The event's name. Every Animation with an event of this name runs the same **Event** node. |
| Time | Where in one pass the event fires, in milliseconds. |
| Duration | 0 for a single event. Above 0, the event is a window: it begins at its Time and ends this many milliseconds later. |
| Trigger Weight | The weight, 0 to 1, the clip must play at for the event to fire. At the default 0.5, a clip fading out of a blend does not fire it. |
| Action | What the event does on its own, without a script: **None**, **Play Sound** (a **Sound** from the actor at a **Volume**) or **Spawn Particle System** (a **Particle System** at a **Bone**, following it, or at the actor when Bone is **None**; Bone lists the Skeleton's [sockets](skeleton.md#sockets) and bones). A window acts as it begins. |

Tap **Remove Event** on an event's card to delete it. While the Preview plays, each event's name flashes over it as playback passes it.

## Additive animations

An additive Animation holds a change, such as a lean, a breath or a flinch, that you add on top of another pose with [Apply Additive](../scripting/animation/apply-additive.md), so one lean works over idle, walk and run alike. Set **Additive** to what the change is measured from:

| Additive | The change is from |
| --- | --- |
| Relative To Rest Pose | The Skeleton's rest pose. |
| Relative To First Frame | The clip's own first frame, so it adds nothing at its start. |
| Relative To Animation | The pose of **Base Animation** at **Base Time**. The Base Animation loads with this one. |

- An additive Animation plays only under an Apply Additive's **Additive** input, and only additive Animations play there; the Animation Graph reports either mistake.
- Positions and rotations add the change; scales multiply by it.
- The **Preview** plays the clip as it is in the file.

## Shared Skeletons

Every Model on a [Skeleton](skeleton.md) plays every Animation on it, whichever file the clip came from. Characters that share a rig and a separate animation file all join one Skeleton when you import them, so their clips need no retargeting.

## Retarget

To play a clip on a character with another Skeleton, select Animation assets in the **Content Browser**, choose **Retarget…** and pick the target Skeleton. Haptic adds a retargeted copy of each clip to the current folder, with the same Duration. Clips with no matching bones on the target are reported in **Retarget Failed**.

## Use it

Play clips in a game with an [Animation Graph](animation-graph.md) and the [Animation Graph component](../components/animation-graph.md).

## Related

- [Models](../graphics/models.md)
- [Skeleton](skeleton.md)
