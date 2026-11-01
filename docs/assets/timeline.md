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
