# Timeline

A **Timeline** asset groups [Timeline Clips](../scenes/timeline.md) from any number of Scenes and Scene Layers. A clip keeps living in its Scene or Scene Layer; binding it to a Timeline Asset only records that the asset holds it.

## Create

In the **Content Browser**, choose **New Asset > Animation > Timeline**. You can also create one from a clip: in a Scene's or Scene Layer's **Clips** window, right-click or long-press the clip and choose **New Timeline Asset and Bind…**. That asset is created next to the Scene or Scene Layer.

## Bind clips

Bind clips from the **Clips** window of their Scene or Scene Layer, in Timeline mode. Right-click or long-press a clip for:

| Command | Does |
| --- | --- |
| **Bind to Timeline Asset…** | Lists the project's Timeline Assets with the clips each already holds. Pick one and tap **Bind**. **New Timeline Asset…** at the top creates one first. |
| **New Timeline Asset and Bind…** | Asks for a name, creates the asset next to the document and binds the clip. |
| **Unbind Timeline Asset** | Removes the clip from its asset. |
| **Show Timeline Asset in Content Browser** | Selects the bound asset in the **Content Browser**. |

A bound clip shows a link icon in **Clips**. Binding is part of the document's undo history.

- A clip belongs to at most one Timeline Asset.
- Clip names must be unique within an asset. The bind list shows an asset that already holds a clip with the same name as unavailable, and says which document holds it. If a rename in another document makes two clips of one asset share a name, **Compiler Results** reports it for both documents.
- **Duplicate**, **Copy** and **Paste** of a clip leave the copy unbound.

## Editor

Double-tap a Timeline asset to open it.

- **Timeline Clips**: the asset's **Description**, and every clip bound to it with its Scene or Scene Layer and its **Length**. **Open** shows that document in Timeline mode with the clip selected. The list is read from the documents that hold the clips, so it follows binds, renames and unsaved edits there.
- **Events**: the selected clip's events: one per [Custom Event Track](../scenes/timeline.md#custom-event-tracks), with its inputs, plus **On Finished** and **On Looped**. The list is read-only; edit the tracks in the clip's Scene or Scene Layer.

Reopen a closed window from the **Windows** menu.

## Scripting

Any script can reach a Timeline asset's clips, even one that runs before their Scenes or Scene Layers load:

1. Add a variable of type **Asset**, with **Asset Type** set to **Timeline**, and pick the asset as its default. You can also pick the asset directly on the node's pin.
2. Connect it to [Get Timeline Object Reference From Timeline Asset](../scripting/class/get-timeline-object-reference-from-timeline-asset.md). It returns the asset's Timeline object, which stays valid for the whole session.
3. Drag from its **Timeline** pin for:

| Node or event | Does |
| --- | --- |
| [Get Timeline Asset Clip](../scripting/class/get-timeline-asset-clip.md), one per clip, such as **Get Intro Timeline Clip** | Returns that clip while its Scene or Scene Layer is loaded, else None. Connect it to the [Timeline Clip nodes](../scenes/timeline.md#control-a-clip-from-a-script). |
| [Get Loaded Timeline Clips](../scripting/class/get-loaded-timeline-clips.md) | Returns every loaded clip of the asset. |
| An event for each event of each clip, named after both, such as **On Door Open (Intro)**, **On Finished (Intro)** and **On Looped (Intro)** | Runs whenever that clip fires the event, with the event's inputs and then the **Timeline Clip** that fired it. Bind it with **Bind Event to** or **Assign**, as for a clip's own [events](../scenes/timeline.md#bind-to-a-clips-events). |

Bind to the Timeline's events once, for example in **Begin Play** of a Game Instance or Game Subsystem, to hear a clip in every Scene or Scene Layer copy that plays it, before any of them loads.

- The nodes and events follow the asset the pin or the variable's default names while you edit. With anything else wired into the asset pin, the Timeline is a plain one with only **Get Loaded Timeline Clips**; **Cast to** the asset narrows it.
- A node whose clip was deleted or unbound from the asset shows an error. A node or variable that names an asset holding no clips shows a warning.
- The asset ships with the game when a script or a bound clip names it.
