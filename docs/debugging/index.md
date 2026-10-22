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
| **Step** | While paused, advances the Simulation by one tick and pauses again. The view shows the new tick. |
| **Stop** (red) | Ends the Simulation. Its tooltip says whether your changes are kept or discarded. |
| **Game** / **Edit** | One button showing the current input; tap it to switch. **Game** sends keys, touch and the mouse to the game. **Edit** lets you select, inspect and move runtime objects with the **Move**, **Rotate** and **Scale** tools in the viewport. Clicking outside the game, or pressing Esc or Tab, also switches to **Edit**. |
| **Return To Scene** | Appears when another tab is open, and brings the simulated scene back. |
| **Debug Instance** | Appears while a Class, Behaviour Tree or Animation Graph is open. Picks which object's graph run you watch ([Watch a graph run](#watch-a-graph-run)). |

The editor camera you move in **Edit** does not change the game camera. Authored documents stay read-only until you stop.

### Pause on errors

When a script throws or a [Log](../scripting/class/log.md) node writes an Error during a Simulation, the Simulation pauses at the end of that tick and opens the graph at the node that caused it. The rest of that tick still runs. Choose **Resume** to carry on, or **Step** to advance one tick at a time.

Each node pauses the Simulation only the first time: later errors from the same node add to its count in the **Preview Session Report** without pausing again. Turn this off with **Pause On Errors** in **Engine Settings > Debugger**.

## Watch a graph run

While a Simulation runs, open a Class, a Behaviour Tree or an Animation Graph to see it run for one object, the way a debugger would.

**Debug Instance** lists the live objects that run the open document:

| Open | Lists |
| --- | --- |
| Class | Every live object whose class is exactly the open Class: actors, components, the Game Instance and subsystems. An object of a subclass is not listed here; open the subclass instead. |
| [Behaviour Tree](../assets/behaviour-tree.md) | The actors that run the tree through a [Behaviour Tree component](../components/behaviour-tree.md). An actor with several Behaviour Tree components runs only the first, so only that one counts. |
| [Animation Graph](../assets/animation-graph.md) | The actors that run the graph through an [Animation Graph component](../components/animation-graph.md), once for each such component. |

Objects with the same name show the start of their id after the name, and a Class component shows its actor in brackets. The list holds the first 128 objects.

- It starts on the first object in the list, shows **None** when there are none, and moves to the first remaining object when the one you watch is destroyed. Choose **None** to stop watching; it stays on **None** until you open another document.
- Pick another object at any time. The graphs show only the object you picked.
- Changing the open document, or opening a Class that has no objects (a function library, for example), changes or removes the list.

When a node runs for that object, its outline turns orange and fades over a quarter of a second. Each new run starts the fade again, so a node that runs every tick stays lit. The wires and pins involved light up with it. With reduced motion turned on in your system settings the highlight does not fade: it stays lit for the same time, then clears.

### Classes and Animation Object graphs

The execution wire that was taken lights up, and so do the data wires the node read, including those that pass through [pure nodes](../scripting/index.md#nodes-and-pins). Nodes without execution pins never get an outline of their own.

Hover a data pin on a computer, or tap its name on a touch screen (tap it again, or anywhere else, to close it), to see the last value it held: `3.5`, a piece of text, or the class and id of an object. Numbers show four decimals at most and long text is cut after about 100 characters. A pin that has not run yet shows **No value yet**. A pin that is not wired shows the value typed on the node itself, so it has no tip. Pins inside a chain of [pure nodes](../scripting/index.md#nodes-and-pins), such as a variable getter feeding a **Multiply** that feeds a **Clamp**, show the value of the chain's latest run, so you can follow a value from link to link. A pure node that nothing ran through has no value yet.

The **Animation Object** mode of an Animation Graph works the same way for the object you picked.

### Behaviour Trees

Every node the tree works on in a tick lights up, along with the wire down to each child it starts or resumes. A task that keeps running stays lit. The composites above it light when they start and each time a child hands control back.

Each node also shows its status for the object you picked: **Running** for every node on the active branch, otherwise the **Success** or **Failure** of its last run. A node that has not run yet shows nothing. Hover a node on a computer, or tap it on a touch screen, to read its status in a tip.

The **Blackboard** window lists the current values of the object's Blackboard.

### Animation Graph State Machines

The **State Machine** lights each state the graph plays in a tick: the active state, and the state a blend is leaving. A transition's wire lights up when the transition is taken. A Both Ways pair is one wire, so it lights for either direction. [Jump To State](../scripting/class/jump-to-state.md) changes the active state without a transition. Transition rule graphs do not show a run.

The graphs stay read-only: watching never changes your assets or the running game. Outside a Simulation a graph shows no highlights and no tips, and editing it works as always. Only a Simulation compiles Class graphs and Animation Object graphs for this. Play, Preview Build and exported games do not, so they pay nothing for it.

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
| [Assert](../scripting/class/assert.md), [Assert Equal](../scripting/class/assert-equal.md), [Assert Is Valid](../scripting/class/assert-is-valid.md) | Report an error for the node when a check fails, so a broken assumption shows up in the **Output Log** and the **Preview Session Report**. |
| [Draw Debug Line](../scripting/class/draw-debug-line.md), [Draw Debug Box](../scripting/class/draw-debug-box.md), [Draw Debug Sphere](../scripting/class/draw-debug-sphere.md) and other Draw Debug nodes | Draw shapes in the world for a set **Duration**. |

Print, Assert and Draw Debug nodes are **Development Only** by default: release exports leave them out. Turn off **Development Only** in the node's **Inspector** to keep one in the exported game.

## After Play

Errors and warnings from the session appear in the **Output Log** window. When Play, Simulate or Preview Build stops after errors or warnings, the **Preview Session Report** opens at the top right of the editor (centered on a phone). It lists the entries under the asset that reported each one; the groups start collapsed.

- Select an entry to open the asset that caused it. A Class opens at the node, including a node inside a function, and a behaviour tree opens at the node.
- The report stays open while you work through the entries, and the editor behind it stays usable.
- An entry that names no asset, or one the project no longer has, shows **No Source**. Selecting it says why nothing opens. If an asset cannot be opened, for example while a Simulation is still stopping, the report says why; select the entry again.
- **Copy Report** copies every entry as text.

The report closes only when you close it: choose **Close** or the close button in its title bar, or press <kbd>Esc</kbd> while the keyboard is inside the report. Pressing the editor behind it, opening an asset from it, or pressing <kbd>Esc</kbd> in a graph or the viewport leaves it open.

## Runaway loops

**Project Settings > General > Infinite Loop Detection** (on by default) stops Play or Preview Build when a script loop runs more than **Loop Count** times (default 1,000,000) in one tick, and reports the node. Release exports do not check.

## In this section

- [Console](console.md): every console command.
- [Profiler](profiler.md): performance recordings, frame capture and trace recording.
