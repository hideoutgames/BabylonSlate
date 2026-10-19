# Debugging

Play mode has tools to pause and step the game, watch performance, inspect live actors and print values from your scripts.

## The Play toolbar

While the game runs, the toolbar at the top right of the game view has these buttons. Hover or long-press one to see its name.

| Control | Use |
| --- | --- |
| **Pause** / **Resume** | Freezes and continues game time, physics and sound. |
| **Step** | While paused, advances the game by one tick. |
| **Stats** | Shows frame rate, frame time, and script and physics time per tick. |
| **Console** | Opens the [console](console.md) for commands. |
| **Inspector** | Opens a read-only view of the live game. |
| **Profiler**, **Capture Frame** | Record performance. See [Profiler](profiler.md). |
| **Stop** | Ends Play and returns to the editor. |

## Choose the tools before you play

The **Debug** menu next to **Play** decides which controls appear. Set it before pressing Play: the menu is out of reach while the game covers the editor.

| Item | Default |
| --- | --- |
| **Play Mode** | **Play**. **Preview Build** plays a packaged build instead ([Preview Build](../publishing/preview-build.md)); **Simulate** runs the open scene inside the editor viewport. The **Play** button shows the mode you chose, and Haptic remembers it. |
| **Start In Open Scene** | On. Starts from the open scene; off starts from the project's Startup Scene. Simulate always uses the open scene. |
| **Start Paused** | Off. Starts the game paused, ready for **Step**. |
| **Overlays** > **Stats** | On |
| **Overlays** > **Console**, **Inspector**, **Profiler** | Off |

**Simulate** needs an open world scene. Whether its changes are kept when you stop is set by **Keep Simulation Changes** in **Engine Settings > Debugger**.

## Simulate controls

While a Simulation runs, its controls sit in the toolbar where **Simulate** was:

| Control | Does |
| --- | --- |
| **Pause** / **Resume** | Freezes gameplay so you can inspect values that would otherwise keep changing. |
| **Stop** (red) | Ends the Simulation. Its tooltip says whether your changes are kept or discarded. |
| **Game** / **Edit** | **Game** sends keys, touch and the mouse to the game. **Edit** lets you select, inspect and move runtime objects with the **Move**, **Rotate** and **Scale** tools in the viewport. Clicking outside the game, or pressing Esc or Tab, also switches to **Edit**. |
| **Return To Scene** | Appears when another tab is open, and brings the simulated scene back. |

The editor camera you move in **Edit** does not change the game camera. Authored documents stay read-only until you stop.

## Stats

Stats shows **fps**, the frame time, and the **script** and **physics** time of the last tick. When script and physics together take more than 8 ms, Stats shows **over 8 ms budget**. Add more rows with the `stat unit`, `stat memory`, `stat draws` and `stat threads` [console commands](console.md).

## Inspector

The Play **Inspector** lists the Game Instance, subsystems, actors and their components. Select one to see its **Identity**, **Transform** and **Variables**. Values are read-only.

The Inspector floats over the game without dimming it, so the Play toolbar, including **Stop**, stays usable. Close it with <kbd>Esc</kbd>, **Close** or the **Inspector** button.

For a selected actor you can also:

- **Use Camera**: view the game through the actor's camera, when it has a Camera component.
- **Destroy Actor**: remove it for this session. The scene itself does not change.

## Print and Draw Debug

| Node | Use |
| --- | --- |
| [Print](../scripting/class/print.md), [Print String](../scripting/class/print-string.md) | Shows a value as text on the game view. Use **Key** to update one line in place instead of adding lines. |
| [Log](../scripting/class/log.md) | Writes a message to the **Output Log** with a severity. |
| [Draw Debug Line](../scripting/class/draw-debug-line.md), [Draw Debug Box](../scripting/class/draw-debug-box.md), [Draw Debug Sphere](../scripting/class/draw-debug-sphere.md) and other Draw Debug nodes | Draw shapes in the world for a set **Duration**. |

Print and Draw Debug nodes are **Development Only** by default: release exports leave them out. Turn off **Development Only** in the node's **Inspector** to keep one in the exported game.

## After Play

Errors and warnings from the session appear in the **Output Log** window. When Play, Simulate or Preview Build stops after errors or warnings, the **Preview Session Report** opens at the top right of the editor (centered on a phone). It lists the entries under the asset that reported each one; the groups start collapsed.

- Select an entry to open the asset that caused it. A Class opens at the node, including a node inside a function, and a behaviour tree opens at the node.
- The report stays open while you work through the entries, and the editor behind it stays usable.
- An entry that names no asset, or one the project no longer has, shows **No Source**. Selecting it says why nothing opens. If an asset cannot be opened, for example while a Simulation is still stopping, the report says why; select the entry again.
- **Copy Report** copies every entry as text.

The report closes only when you close it: choose **Close** or the close button in its title bar, or press <kbd>Esc</kbd>. Pressing the editor behind it, or opening an asset from it, leaves it open.

## Runaway loops

**Project Settings > General > Infinite Loop Detection** (on by default) stops Play or Preview Build when a script loop runs more than **Loop Count** times (default 1,000,000) in one tick, and reports the node. Release exports do not check.

## In this section

- [Console](console.md): every console command.
- [Profiler](profiler.md): performance recordings, frame capture and trace recording.
