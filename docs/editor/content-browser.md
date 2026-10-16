# Content Browser

The Content Browser holds every asset in your project. Use it to create, import, organise and open assets.

It is always the first document tab and cannot be closed. Press <kbd>Alt</kbd>+<kbd>B</kbd> to switch to it.

## Layout

- **Folders** on the left shows the folder tree. Drag the divider (**Resize Folders**) to change its width.
- The asset grid on the right shows the selected folder. Double-tap an asset to open it, or a folder to go into it.
- On a phone, choose the folder button above the grid to open **Folders**.

The toolbar above the grid has:

| Control | Use |
| --- | --- |
| Import | Import files into the current folder. See [Importing Assets](importing.md). |
| New Asset | Create an asset in the current folder. See [Assets](../assets/index.md) for every type. |
| Search assets… | Filter the grid by name. |
| Filter | Show only the asset types you tick under **Asset Types**. |
| Sort | **Name A–Z**, **Name Z–A**, **Type A–Z**, **Type Z–A**, **Date Modified (Newest)** or **Date Modified (Oldest)**. |

## Select assets

- Tap a tile to select it. Drag across tiles to select each one you pass over.
- Tap empty space to clear the selection.
- With a selection, the toolbar shows **Open** (for one asset or folder), **Deselect** and **Delete (N)**.

## Asset menu

Hold or right-click an asset to open its menu. Items depend on the selection:

| Item | Description |
| --- | --- |
| Open | Open the asset in its editor. |
| Generate Thumbnail | Redraw the thumbnail of a Model, Animation, Material or actor Class. |
| Import MSDF Atlas… | Fonts only. Attach a pre-made MSDF atlas (JSON and PNG). |
| Create Material Instance | Materials and Material Instances only. Make a new instance of it. |
| Duplicate | Copy the selection in place. |
| Rename | Rename one asset or folder. References to it stay connected. |
| Retarget… | Animations only. Retarget the selected Animations to another Skeleton. |
| Move… / Copy to Folder… | Move or copy the selection to a folder you pick. |
| Copy Asset Reference | Copy the asset's ID to the clipboard. |
| Show References | Open the references graph (below). |
| Delete | Delete the selection. |

Hold empty space in the grid for **New Folder**, **New Asset** and **Import**.

## Move assets

- Hold a row in the folder tree, then drag it onto a folder.
- Or choose **Move…** and pick the destination.

References to moved and renamed assets stay connected. You cannot move assets between your project's folders and a plugin's folders; use **Copy to Folder…** instead, which gives the copy a new identity.

## Delete assets

Deleting asks for confirmation and cannot be undone.

- If other assets or settings use what you are deleting, the dialog lists them under **Referenced By**. Confirm with **Delete And Update References** to clear those references.
- When you delete a Class that is used elsewhere, choose a replacement under **Replace Class**, or leave **None**.

## Show References

**Show References** (<kbd>Alt</kbd>+<kbd>R</kbd>) draws a graph of what the asset uses and what uses it.

- Select a node to see its path. Double-tap it, or choose **Open Asset**, to open it.
- **Focus Asset** returns to the asset you started from.

## Plugin content

Plugin folders appear in the tree when **Project Settings > Plugins > Show Plugin Content** is on. Engine plugins are marked **(Read Only)**: you cannot create, import or delete there. See [Plugins](../projects/plugins.md).

When [Source Control](../projects/source-control.md) is on, locked assets show a lock badge with the owner's name.
