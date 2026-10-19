# Scripting

Haptic uses visual scripting: you build game logic by placing nodes in a graph and connecting their pins with wires. Gameplay logic lives in **Class** assets, whose graphs hold events, functions and variables. Materials, particle effects, animation and AI each have their own kind of graph that works the same way.

## Graph types

| Graph | Lives in | Node reference |
| --- | --- | --- |
| Class graph | [Class](../assets/class.md) assets | [Class Nodes](class/index.md) |
| Material graph | [Material](../assets/material.md) and [Material Function](../assets/material-function.md) assets | [Material Nodes](material/index.md) |
| Particle Graph | [Particle Graph](../assets/particle-graph.md) assets | [Particle Graph Nodes](particle/index.md) |
| Animation Graph | [Animation Graph](../assets/animation-graph.md) assets | [Animation Graph Nodes](animation/index.md) |
| Behaviour Tree | [Behaviour Tree](../assets/behaviour-tree.md) assets | [Behaviour Tree Nodes](behaviour-tree/index.md) |

The pages in this section cover Class graphs.

## Nodes and pins

- **Execution pins** (diamonds) set the order things happen. An event such as [Event Begin Play](class/event-begin-play.md) starts a chain; each node runs, then passes execution on through its output.
- **Data pins** (coloured circles) carry values. The colour shows the [pin type](pin-types.md).
- **Pure nodes** have no execution pins, such as [Add](class/add.md) or [Get Actor Location](class/get-actor-location.md). They produce a value when a connected node needs it.
- **Latent nodes**, such as [Delay](class/delay.md), finish later without pausing the rest of the game. They show a clock icon.

## Add a node

Open **Add Node** in any of these ways:

- Double-tap or right-click (long-press on touch) empty canvas.
- Tap **Add Node** (**+**) in the graph toolbar. The node appears in the middle of the canvas, or in the nearest free spot when something is already there.
- Drag a wire from a pin and release it on empty canvas. The new node connects to that pin.

Type in **Search Nodes** or browse the categories. Search words can be in any order and spaces are optional, so **Int to String** finds **To String (Int)** and **BeginPlay** finds **Event Begin Play**. The best match comes first: node names before aliases (such as **label** for **Set Text**), and those before descriptions. Categories are listed by their best match, and the highlighted first row is the one **Enter** adds. **Context Sensitive** is on by default: it hides nodes that need a target object from another class, and when you drag from a pin it shows only compatible nodes. Turn it off to see every node the graph allows.

## Connect pins

- Drag from one pin to another, or tap a pin and then tap the pin to connect.
- A data input takes one wire. Connecting a new wire replaces the old one.
- An execution output drives one wire; an execution input accepts several. Connecting a second wire from an execution output replaces the first and shows **Replaced the existing wire. Use a Sequence to run several.** To run several nodes in order, wire the output to a [Sequence](class/sequence.md).
- While you drag a wire over a pin it cannot connect to, a label gives the reason, such as **Float does not connect to Vector 3**.
- Most unconnected data inputs show an inline value you can edit on the node or in the **Inspector**. Object and actor inputs must be wired, unless the node's page says an unconnected one uses the actor running the graph.
- Shake a node while dragging it to disconnect all its wires.

The graph toolbar also has icon buttons for **Copy**, **Paste**, **Delete**, **Break Links** (removes the wires of the selected nodes) and **Format** (tidies the selected chains); hover or long-press one to see its name. The zoom controls at the bottom left show the zoom level; tap it to return to 100%.

Right-click a node (long-press on touch) for a menu with **Copy**, **Paste**, **Duplicate**, **Delete** and **Break Links**, plus actions such as **Rename Event** where they apply. Opening the menu on an unselected node selects only that node; opening it on a selected node keeps the whole selection. **Paste** and **Duplicate** add new nodes with the same values and the wires that ran between the copied nodes, offset from the originals. Nodes a graph protects, such as a function's **Input** and **Output**, cannot be copied, duplicated or deleted. Events keep their one place on the graph: a copied custom event gets a new name, and an event the graph already has is left out, as described in [Copy and duplicate events](events.md#copy-and-duplicate-events). The same actions have keyboard shortcuts: <kbd>Mod</kbd>+<kbd>C</kbd>, <kbd>Mod</kbd>+<kbd>V</kbd>, <kbd>Mod</kbd>+<kbd>D</kbd> and <kbd>Delete</kbd> or <kbd>Backspace</kbd> ([Keyboard Shortcuts](../start/shortcuts.md)). Gestures are listed in [Touch gestures](../start/gestures.md).

**Engine Settings > Graph** controls the **Node Connection Assistant** (suggests wires when you move a node near compatible pins), its **Connection Distance (Pixels)** (48 by default), **Shake Nodes To Disconnect**, **Read-Only Pin Defaults** and **Graph Default Zoom**.

## Compile and play

Graphs are checked as you edit. Problems appear in **Compiler Results** and as red badges on nodes; tap a result to jump to the node.

1. Tap **Compile** in the toolbar, or press <kbd>F7</kbd>. **Compiler Results** lists the errors and warnings of the class you have open, and **Compilation Error** appears next to the button while it has errors.
2. Press Play. Play compiles the graphs the game uses: the scene it starts in, the Game Instance, the Game and Scene Subsystems, and every class they use. Other classes are not checked.
3. If any of those graphs has errors, the **Compile errors** dialog lists them. Tap a row to go to the node, or choose **Play Anyway**.

Warnings never block Play. A loop that never ends stops Play and reports **Infinite loop detected**.

To see a class run, start a Simulation with the class open: the nodes that run light up for the object you pick, and pins show their last values ([Watch a graph run](../debugging/index.md#watch-a-graph-run)).

Results you may meet while wiring:

| Result | Meaning |
| --- | --- |
| **Required input "…" is not connected** | An object or actor input has no wire (error), or a class or asset input has nothing selected (warning). Inputs with an inline value never raise it. |
| **Event … appears more than once in this graph** | Error. An event can be on the graph once, so it would run twice. Keep one and use a [Sequence](class/sequence.md) to run several things. |
| **Input "…" reads from …, which never runs** | Warning. A node with execution pins only runs when an execution wire reaches it, so the value you read from it is always empty. Wire the node into the chain before the node that reads it. |

::: tip
[Print](class/print.md), [Print String](class/print-string.md) and the Draw Debug nodes are **Development Only** by default: they run in the editor but are left out of an exported game unless **Project Settings > Export > Bundle Debugger** is on. You can set **Development Only** on any node in the **Inspector**.
:::

## In this section

- [Classes](classes.md)
- [Variables](variables.md)
- [Functions](functions.md)
- [Events](events.md)
- [Pin Types](pin-types.md)
- [Script Interfaces](interfaces.md)
- [Structures and Enums](structures-and-enums.md)
- [Tags](tags.md)
- [Data Definitions and Data Trees](data.md)
- [Save Games](save-games.md)
- [Game Instance and Subsystems](game-instance.md)
- [Editor Scripting](editor-scripting.md)
- [Execute JavaScript](javascript.md)
