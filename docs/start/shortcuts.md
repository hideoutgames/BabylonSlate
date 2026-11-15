# Keyboard Shortcuts

With a keyboard attached, editor commands have shortcuts. You can change any of them.

<kbd>Mod</kbd> is Command on Apple devices, including an iPad with a keyboard, and Ctrl elsewhere. <kbd>Alt</kbd> is Option on Apple keyboards. Menus and tooltips show each command's current shortcut. A shortcut on <kbd>Space</kbd> or <kbd>Enter</kbd> does nothing while a button, checkbox or other control has keyboard focus: the key presses that control instead.

## Default shortcuts

### General

| Command | Shortcut |
| --- | --- |
| Save All | <kbd>Mod</kbd>+<kbd>S</kbd> |
| Undo | <kbd>Mod</kbd>+<kbd>Z</kbd> |
| Redo | <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> or <kbd>Mod</kbd>+<kbd>Y</kbd> |
| Search Project | <kbd>Mod</kbd>+<kbd>K</kbd> |
| Toggle Focus | <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> |
| Project Settings | <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd> |
| Engine Settings | <kbd>Mod</kbd>+<kbd>,</kbd> |
| Packaging | <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> |
| Project Browser | <kbd>Mod</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> |
| Content Browser | <kbd>Alt</kbd>+<kbd>B</kbd> |

**Project Browser** closes the project and returns to the Homepage.

### Documents

| Command | Shortcut |
| --- | --- |
| Close Document | <kbd>Alt</kbd>+<kbd>W</kbd> |
| Close Open Tabs | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> |
| Next Document | <kbd>Alt</kbd>+<kbd>Page Down</kbd> |
| Previous Document | <kbd>Alt</kbd>+<kbd>Page Up</kbd> |

### Play

| Command | Shortcut |
| --- | --- |
| Play | <kbd>Alt</kbd>+<kbd>P</kbd> |
| Compile | <kbd>F7</kbd> |
| Toggle Breakpoint | <kbd>F9</kbd> |
| Enable Or Disable Breakpoint | <kbd>Mod</kbd>+<kbd>F9</kbd> |
| Edit Breakpoint | <kbd>Shift</kbd>+<kbd>F9</kbd> |

The breakpoint shortcuts act on every selected node in a graph. **Edit Breakpoint** needs exactly one selected node with a breakpoint.

### Viewport

| Command | Shortcut |
| --- | --- |
| Move Tool | <kbd>1</kbd> |
| Rotate Tool | <kbd>2</kbd> |
| Scale Tool | <kbd>3</kbd> |
| Cycle Transform Tool | <kbd>Space</kbd> |
| Frame Selection | <kbd>F</kbd> |
| Toggle Snap Grid | <kbd>G</kbd> |
| Toggle Grid | <kbd>Shift</kbd>+<kbd>G</kbd> |
| Toggle Collisions | <kbd>Alt</kbd>+<kbd>C</kbd> |
| Toggle Navmesh | <kbd>Shift</kbd>+<kbd>N</kbd> |
| Toggle Game Camera | <kbd>Shift</kbd>+<kbd>C</kbd> |
| Toggle Drag Select | <kbd>Q</kbd> |
| Switch 2D / 3D | <kbd>Alt</kbd>+<kbd>V</kbd> |
| Drop Selection | <kbd>End</kbd> |
| Design Mode | <kbd>Shift</kbd>+<kbd>1</kbd> |
| Landscape Mode | <kbd>Shift</kbd>+<kbd>2</kbd> |
| Foliage Mode | <kbd>Shift</kbd>+<kbd>3</kbd> |
| Script Mode | <kbd>Shift</kbd>+<kbd>4</kbd> |
| Timeline Mode | <kbd>Shift</kbd>+<kbd>5</kbd> |

The mode shortcuts switch the active Scene between its Design, Landscape, Foliage, Script and [Timeline](../scenes/timeline.md) modes, as the Scene Mode menu in the toolbar does; a Scene Layer has only Design, Script and Timeline. They do nothing during Play.

<kbd>W</kbd>, <kbd>A</kbd>, <kbd>S</kbd> and <kbd>D</kbd> fly the camera in 3D and pan it in 2D. They are not editor commands and cannot be rebound.

### Editing

| Command | Shortcut |
| --- | --- |
| Cut | <kbd>Mod</kbd>+<kbd>X</kbd> |
| Copy | <kbd>Mod</kbd>+<kbd>C</kbd> |
| Paste | <kbd>Mod</kbd>+<kbd>V</kbd> |
| Select All | <kbd>Mod</kbd>+<kbd>A</kbd> |
| Duplicate | <kbd>Mod</kbd>+<kbd>D</kbd> |
| Rename | <kbd>F2</kbd> |
| Delete | <kbd>Delete</kbd> or <kbd>Backspace</kbd> |
| Break Links | <kbd>Alt</kbd>+<kbd>L</kbd> |
| Search Panel | <kbd>Mod</kbd>+<kbd>F</kbd> |
| New Folder | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> |
| Place Actors | <kbd>Alt</kbd>+<kbd>A</kbd> |

Duplicate, Rename, Delete, Search Panel and New Folder act on the panel that has keyboard focus, the **Outliner** or the **Content Browser**. Place Actors needs the Outliner to have focus. Copy and Paste copy actors when the Outliner has focus, and copy Class members when the **Class** window has focus ([Select, copy and paste members](../scripting/classes.md#select-copy-and-paste-members)). In a graph, Copy, Paste, Duplicate and Delete act on the selected nodes; see [When shortcuts work](#when-shortcuts-work).

When a Tilemap's **Paint** window has focus, Select All and Paste switch to its **Select** tool, and Cut, Copy and Delete act on the tiles it selected ([Select and move tiles](../assets/tilemap.md#select-and-move-tiles)). There, the arrow keys also move the selected tiles, holding one down included, and <kbd>Enter</kbd> and <kbd>Esc</kbd> place or cancel a paste; these keys cannot be rebound.

### Timeline

| Command | Shortcut |
| --- | --- |
| Set Key | <kbd>K</kbd> |
| Previous Key | <kbd>[</kbd> |
| Next Key | <kbd>]</kbd> |
| Add Selected Actors | <kbd>Shift</kbd>+<kbd>A</kbd> |

Set Key, Previous Key and Next Key act in the [Timeline](../scenes/timeline.md#keys) window when it has keyboard focus; Copy, Paste, Duplicate and Delete there act on keys. Add Selected Actors adds the actors selected in the viewport or **Outliner** to the clip while the **Timeline** window is shown.

### Content Browser

| Command | Shortcut |
| --- | --- |
| New Asset | <kbd>Alt</kbd>+<kbd>N</kbd> |
| Import Assets | <kbd>Alt</kbd>+<kbd>I</kbd> |
| Show References | <kbd>Alt</kbd>+<kbd>R</kbd> |

### Tilemap Paint

| Command | Shortcut |
| --- | --- |
| Move Tool | <kbd>M</kbd> |
| Select Tool | <kbd>S</kbd> |
| Brush Tool | <kbd>B</kbd> |
| Eraser Tool | <kbd>E</kbd> |
| Rect Tool | <kbd>R</kbd> |
| Bucket Tool | <kbd>G</kbd> |
| Stamp Tool | <kbd>T</kbd> |
| Picker Tool | <kbd>I</kbd> |

These pick a tool in a Tilemap's [Paint](../assets/tilemap.md#editor) window while it has keyboard focus: tap or click the map first. They never act anywhere else, so <kbd>G</kbd> still toggles the snap grid in a Scene viewport and <kbd>S</kbd> still moves its camera.

## When shortcuts work

- Shortcuts are off while Play runs and while a dialog is open.
- In a text field, only Save All, Search Project, Engine Settings and Search Panel work; other keys, the Tilemap Paint tool keys included, type as usual.
- Holding a key repeats only Undo and Redo, and the arrow keys in Tilemap **Paint**.
- Commands whose button is hidden or unavailable do nothing.
- In a graph, Copy, Paste, Duplicate and Delete act on the graph you last tapped or focused, and your shortcuts for them apply. Delete removes the selected nodes and wires. Duplicate copies and pastes the selected nodes in one step without changing what Copy last stored, and keeps the browser's bookmark shortcut from opening. Pasted events stay unique: custom events are renamed and an event the graph already has is left out ([Copy and duplicate events](../scripting/events.md#copy-and-duplicate-events)). Protected nodes stay, and a graph that hides **Copy** and **Paste** in its toolbar has no shortcut for them. Keys typed in a text field, a menu or a dialog work as usual.

## Change a shortcut

1. Open **Engine Settings > Keybinds**. Commands are grouped as in the tables above.
2. Select the shortcut next to a command, then press the new keys. For a two-step shortcut, press the second keys straight after the first. <kbd>Esc</kbd> cancels.
3. Use **Unassign** to remove a shortcut or **Reset to Default** to restore one. **Reset All** restores every shortcut.

If a shortcut is already in use where the command works, or is the first step of another command's two-step shortcut, the row warns "Also used by" and names the other command. Tilemap Paint commands share keys with Viewport, Timeline and Content Browser commands without a warning, since those never work in a Tilemap. Viewport commands also warn when you choose W, A, S or D. Searching Engine Settings finds commands by name.

Shortcuts are stored with Engine Settings on this device, not in the project.
