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
| **Debug Instance** | Appears while a Class is open. Picks which object's graph run you watch ([Watch a graph run](#watch-a-graph-run)). |

The editor camera you move in **Edit** does not change the game camera. Authored documents stay read-only until you stop.

## Watch a graph run

While a Simulation runs, open a Class to see its graphs run for one object, the way a debugger would.

**Debug Instance** lists every live object whose class is exactly the open Class: actors, components, the Game Instance and subsystems. An object of a subclass is not listed here; open the subclass instead. Objects with the same name show the start of their id after the name, and a component shows its actor in brackets. The list holds the first 128 objects.

- It starts on the first object in the list, shows **None** when there are none, and moves to the first remaining object when the one you watch is destroyed. Choose **None** to stop watching; it stays on **None** until you open another Class.
- Pick another object at any time. The graphs show only the object you picked.
- Changing the open Class, or a Class that has no objects (a function library, for example), changes or removes the list.

When a node runs for that object, its outline turns orange and fades over a quarter of a second. Each new run starts the fade again, so a node that runs every tick stays lit. The pins and wires involved light up with it: the execution wire that was taken, and the data wires the node read, including those that pass through [pure nodes](../scripting/index.md#nodes-and-pins). Nodes without execution pins never get an outline of their own. With reduced motion turned on in your system settings the highlight does not fade: it stays lit for the same time, then clears.

Hover a data pin on a computer, or tap its name on a touch screen, to see the last value it held: `3.5`, a piece of text, or the class and id of an object. Numbers show four decimals at most and long text is cut after about 100 characters. A pin that has not run yet shows **No value yet**. A pin that is not wired shows the value typed on the node itself, so it has no tip. A pure node's pins show the value a node that ran read through them.

The graphs stay read-only: watching never changes your Class or the running game. Only a Simulation compiles Class graphs for this. Play, Preview Build and exported games do not, so they pay nothing for it.

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

Errors and warnings from the session appear in the **Output Log** window. When Play stops after errors or warnings, the **Preview Session Report** lists them; tap a row to open the graph or tree node that caused it.

## Runaway loops

**Project Settings > General > Infinite Loop Detection** (on by default) stops Play or Preview Build when a script loop runs more than **Loop Count** times (default 1,000,000) in one tick, and reports the node. Release exports do not check.

## In this section

- [Console](console.md): every console command.
- [Profiler](profiler.md): performance recordings, frame capture and trace recording.
