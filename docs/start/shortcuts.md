# Keyboard Shortcuts

With a keyboard attached, editor commands have shortcuts. You can change any of them.

<kbd>Mod</kbd> is Command on Apple devices, including an iPad with a keyboard, and Ctrl elsewhere. <kbd>Alt</kbd> is Option on Apple keyboards. Menus and tooltips show each command's current shortcut.

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
| Content Browser | <kbd>Alt</kbd>+<kbd>B</kbd> |

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

### Viewport

| Command | Shortcut |
| --- | --- |
| Move Tool | <kbd>1</kbd> |
| Rotate Tool | <kbd>2</kbd> |
| Scale Tool | <kbd>3</kbd> |
| Frame Selection | <kbd>F</kbd> |
| Toggle Snap Grid | <kbd>G</kbd> |
| Toggle Grid | <kbd>Shift</kbd>+<kbd>G</kbd> |
| Toggle Collisions | <kbd>Alt</kbd>+<kbd>C</kbd> |
| Toggle Navmesh | <kbd>Shift</kbd>+<kbd>N</kbd> |
| Toggle Game Camera | <kbd>Shift</kbd>+<kbd>C</kbd> |
| Toggle Drag Select | <kbd>Q</kbd> |
| Switch 2D / 3D | <kbd>Alt</kbd>+<kbd>V</kbd> |
| Drop Selection | <kbd>End</kbd> |

<kbd>W</kbd>, <kbd>A</kbd>, <kbd>S</kbd> and <kbd>D</kbd> fly the camera in 3D and pan it in 2D. They are not editor commands and cannot be rebound.

### Editing

| Command | Shortcut |
| --- | --- |
| Copy | <kbd>Mod</kbd>+<kbd>C</kbd> |
| Paste | <kbd>Mod</kbd>+<kbd>V</kbd> |
| Duplicate | <kbd>Mod</kbd>+<kbd>D</kbd> |
| Rename | <kbd>F2</kbd> |
| Delete | <kbd>Delete</kbd> or <kbd>Backspace</kbd> |
| Search Panel | <kbd>Mod</kbd>+<kbd>F</kbd> |
| New Folder | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> |
| Place Actors | <kbd>Alt</kbd>+<kbd>A</kbd> |

Duplicate, Rename, Delete, Search Panel and New Folder act on the panel that has keyboard focus, the **Outliner** or the **Content Browser**. Copy, Paste and Place Actors need the Outliner to have focus. In a graph, Copy, Paste, Duplicate and Delete act on the selected nodes; see [When shortcuts work](#when-shortcuts-work).

### Content Browser

| Command | Shortcut |
| --- | --- |
| New Asset | <kbd>Alt</kbd>+<kbd>N</kbd> |
| Import Assets | <kbd>Alt</kbd>+<kbd>I</kbd> |
| Show References | <kbd>Alt</kbd>+<kbd>R</kbd> |

## When shortcuts work

- Shortcuts are off while Play runs and while a dialog is open.
- In a text field, only Save All, Search Project, Engine Settings and Search Panel work; other keys type as usual.
- Holding a key repeats only Undo and Redo.
- Commands whose button is hidden or unavailable do nothing.
- In a graph, Copy, Paste, Duplicate and Delete act on the graph you last tapped or focused, and your shortcuts for them apply. Delete removes the selected nodes and wires. Duplicate copies and pastes the selected nodes in one step without changing what Copy last stored, and keeps the browser's bookmark shortcut from opening. Protected nodes stay, and a graph that hides **Copy** and **Paste** in its toolbar has no shortcut for them. Keys typed in a text field, a menu or a dialog work as usual.

## Change a shortcut

1. Open **Engine Settings > Keybinds**. Commands are grouped as in the tables above.
2. Select the shortcut next to a command, then press the new keys. <kbd>Esc</kbd> cancels.
3. Use **Unassign** to remove a shortcut or **Reset to Default** to restore one. **Reset All** restores every shortcut.

If a shortcut is already in use, the row warns "Also used by" and names the other command. Viewport commands also warn when you choose W, A, S or D. Searching Engine Settings finds commands by name.

Shortcuts are stored with Engine Settings on this device, not in the project.
