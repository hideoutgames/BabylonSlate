# Content Browser

The Content Browser holds every asset in your project. Use it to create, import, organise and open assets.

It is always the first document tab and cannot be closed. Press <kbd>Alt</kbd>+<kbd>B</kbd> to switch to it.

## Layout

- **Folders** on the left shows the folder tree. Drag the divider (**Resize Folders**) to change its width. With **Filter** set, the tree lists only assets of the ticked types; every folder still shows.
- The asset grid on the right shows the selected folder. Double-tap an asset to open it, or a folder to go into it.
- On a phone, choose the folder button above the grid to open **Folders**.

The toolbar above the grid has:

| Control | Use |
| --- | --- |
| Import | Import files into the current folder. See [Importing Assets](importing.md). |
| New Asset | Open a menu with **Folder** first, then the asset types grouped by category, with a search field at the top. **Folder** creates a folder at once (see [New folders](#new-folders)). Pick a type, then name the asset to create it in the current folder. Click **Location** to pick a different folder before you create it. See [Assets](../assets/index.md) for every type. |
| Search assets… | Filter the grid by name. |
| Filter | Show only the asset types you tick under **Asset Types**, in the grid and the folder tree. Folders always show. |
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
| Import MSDF Atlas… | Fonts only. Attach a pre-made MSDF atlas: pick one JSON and the PNG it names. A JSON that names no atlas page pairs only with a PNG of the same name that contains `msdf`, such as `Ui-msdf.png` for `Ui-msdf.json`. A second JSON or any other PNG in the pick is refused. |
| Create … | Make a new asset from the selection. See [Create from assets](#create-from-assets). |
| Duplicate | Copy the selection in place. |
| Rename | Rename one asset or folder. References to it stay connected. |
| Retarget… | Animations only. Retarget the selected Animations to another Skeleton. |
| Move… / Copy to Folder… | Move or copy the selection to a folder you pick. |
| Copy Asset Reference | Copy the asset's ID to the clipboard. If the clipboard refuses the copy, the Content Browser says so. |
| Show References | Open the references graph (below). |
| Delete | Delete the selection. |

Double-tap empty space in the grid to open the **New Asset** menu there. Hold or right-click empty space in the grid for **New Folder**, **New Asset** and **Import**, or empty space in the folder tree for **New Folder**.

### Create from assets

The **Create** items build a new asset from the selected assets. Each one appears only when every selected asset is of a type it takes, and no folder is selected. The new asset goes in the same folder as its source (the first selected asset, in name order) and opens. When one choice makes several assets, none of them opens.

New assets are named after their source. If that name is taken by an asset of the same type in the folder, `_1`, `_2`, … is added.

| Item | Takes | Makes |
| --- | --- | --- |
| Create Instance | One Material or Material Instance | A [Material Instance](../assets/material-instance.md) of it, named `<Name>_Instance`. |
| Create Sprite / Create Sprites | Textures | One [Sprite](../assets/sprite.md) per Texture, showing the whole image with the default pivot and collision box. |
| Create Sprite Animation | Textures and Sprites, mixed | One [Sprite Animation](../assets/sprite-animation.md) with a frame per asset, in name order (`Run_2` before `Run_10`), named after the first without its trailing number (`Run_1` makes `Run`). |
| Create Tileset | One Texture | A [Tileset](../assets/tileset.md) of it, sized from the Texture. |
| Create Material | Textures | A [Material](../assets/material.md) per group of Textures that share a name before a map suffix (below). |
| Create Tilemap | Tilesets | One [Tilemap](../assets/tilemap.md) with every selected Tileset in its Palette, using the first Tileset's tile size. |
| Create Prefab | Models | One [Prefab](../assets/prefab.md) with a Mesh component for each Model. |
| Create Actor | Models, Sprites and Particle Systems, mixed | One Actor [Class](../assets/class.md) with a component for each asset: a Mesh for a Model, a Sprite for a Sprite, and a Particle component that plays on start for a Particle System. |
| Create Particle System | Up to eight Basic Particle Emitters and Particle Graphs | A [Particle System](../assets/particle-system.md) that plays them together. |
| Create Child Class | One Class | A Class whose parent is that Class, named `<Name>_Child`. Not offered for a Class that cannot have children. |
| Create Data Definition | One Structure | A [Data Definition](../assets/data-definition.md) whose fields start as the Structure's. |
| Create Data Tree | One Data Definition | A [Data Tree](../assets/data-tree.md) that uses the Data Definition. |
| Create Render Target Texture | One Render Target | A [Render Target Texture](../assets/render-target-texture.md) that shows the Render Target. |

**Create Material** reads the end of each Texture's name:

| Name ends in | Wired to |
| --- | --- |
| `_normal`, `_norm`, `_nrm`, `_nor` | **Normal**, through a Normal Map node |
| `_roughness`, `_rough`, `_rgh` | **Roughness** (red channel) |
| `_metallic`, `_metalness`, `_metal`, `_mtl` | **Metallic** (red channel) |
| `_emissive`, `_emission`, `_emit` | **Emissive** |
| `_basecolor`, `_albedo`, `_diffuse`, `_diff`, `_color`, `_col`, or none of these | **Base Color** |

A `-`, `.` or space works in place of `_`, and case does not matter, so `Rock_albedo`, `Rock_Normal` and `rock-rough` make one Material named `Rock`. Textures ending in `_ao` or `_occlusion` join their group but are not used, because Materials have no occlusion input. A group without a Base Color Texture keeps the default color. If two Textures in a group end the same way, the first in name order is used.

## New folders

**New Folder** creates a folder named `NewFolder` (`NewFolder_1`, `_2`, … when that name is taken) in the current folder, selects it and opens its name for editing, with no dialog. Type a name and press <kbd>Enter</kbd>, or tap elsewhere. <kbd>Esc</kbd> keeps `NewFolder`. A name that is invalid or already used opens **Rename Folder** with the reason.

Create a folder with **Folder** in the **New Asset** menu, **New Folder** in the empty-space menu of the grid or the folder tree, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>. From the folder tree, the name opens in the tree; otherwise it opens on the folder's tile in the grid.

While **Duplicate** or **Copy to Folder…** runs, a progress window shows the item being copied and how many files are done. Choose **Cancel** to stop; the copies made so far are removed, so the content is left as it was.

A heavy asset can take a long time to draw on a slow device. A thumbnail that takes too long keeps the asset's type icon, and Haptic may try once more, with more time, when nothing else is waiting. Choose **Generate Thumbnail** to draw it again at any time.

## Move assets

- Hold a row in the folder tree, then drag it onto a folder.
- Or choose **Move…** and pick the destination.

References to moved and renamed assets stay connected.

You can also move assets and folders between your project's folders and a plugin's folders, in either direction. They keep their identity, so everything that uses them still does. Engine plugins are read-only: nothing moves into or out of them. **Copy to Folder…** copies only within the same project or plugin.

When a move changes how a plugin behaves, **Move…** shows **Plugin Content Changes** before you confirm. A drag that would cause such a change opens **Move…** instead of moving at once. You see this when:

- A plugin would use project content, or content of a plugin it does not list as a dependency. A copy of the plugin exported or installed in another project would be missing that content.
- An export preset turns the plugin off. Exports from that preset would leave out what you moved.

## Delete assets

Deleting asks for confirmation and cannot be undone.

- If other assets or settings use what you are deleting, the dialog lists them under **Referenced By**. **Delete** clears those references.
- When you delete a Class that is used elsewhere, choose a replacement under **Replace Class**, or leave **None**. **Delete** then asks once more: review the replacements and confirm with **Delete And Update References**.

## Show References

**Show References** (<kbd>Alt</kbd>+<kbd>R</kbd>) draws a graph of what the asset uses and what uses it.

- Select a node to see its path. Double-tap it, or choose **Open Asset**, to open it.
- **Focus Asset** returns to the asset you started from.

## Plugin content

Plugin folders appear in the tree when **Project Settings > Plugins > Show Plugin Content** is on. Engine plugins are marked **(Read Only)**: you cannot create, import, move or delete there. See [Plugins](../projects/plugins.md).

When [Source Control](../projects/source-control.md) is on, locked assets show a lock badge with the owner's name.
