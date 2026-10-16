# Debugging

Play mode has tools to pause and step the game, watch performance, inspect live actors and print values from your scripts.

## The Play toolbar

While the game runs, the toolbar at the top right of the game view has:

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

| Group | Item | Default |
| --- | --- | --- |
| Play Overlay | Stats | On |
| Play Overlay | Console, Inspector, Profiler | Off |
| Session | Pause On Play | Off. Starts the game paused, ready for **Step**. |
| Session | Preview Build | Off. Plays a packaged build instead. See [Preview Build](../publishing/preview-build.md). |
| Session | Play from Scene | On. Starts from the open scene; off starts from the project's Startup Scene. |

## Stats

Stats shows **fps**, the frame time, and the **script** and **physics** time of the last tick. When script and physics together take more than 8 ms, Stats shows **over 8 ms budget**. Add more rows with the `stat unit`, `stat memory`, `stat draws` and `stat threads` [console commands](console.md).

## Inspector

The Play **Inspector** lists the Game Instance, subsystems, actors and their components. Select one to see its **Identity**, **Transform** and **Variables**. Values are read-only.

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

Errors and warnings from the session appear in the **Output Log** window. When Play stops after errors or warnings, the **Preview Session Report** lists them; tap a row to open the graph or tree node that caused it.

## Runaway loops

**Project Settings > General > Infinite Loop Detection** (on by default) stops Play or Preview Build when a script loop runs more than **Loop Count** times (default 1,000,000) in one tick, and reports the node. Release exports do not check.

## In this section

- [Console](console.md): every console command.
- [Profiler](profiler.md): performance recordings, frame capture and trace recording.
