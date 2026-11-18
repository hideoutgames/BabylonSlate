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
- **Reference pins** (small diamonds) take a variable rather than a value, and the node can change that variable. See [Reference pins](pin-types.md#reference-pins).
- **Pure nodes** have no execution pins, such as [Add](class/add.md) or [Get Actor Location](class/get-actor-location.md). They produce a value when a connected node needs it: once for each execution node that runs, however many wires leave the pure node, and again for the next execution node. A [Random Float](class/random-float.md) wired to two inputs of one node is one number; to keep a value across several execution nodes, store it in a variable.
- **Latent nodes**, such as [Delay](class/delay.md), finish later without pausing the rest of the game. They show a clock icon.
- **Node icons:** the icon left of a node's title shows what kind of node it is: **E** for events, **ƒ** in a square for functions, a plain **ƒ** for pure nodes, a clock for latent nodes, a gamepad for input events, a plug for interface functions, a radio tower for Event Dispatcher and Call Custom Event nodes, an upward arrow for Call Parent, a fork for flow control, a looping arrow for loops and **(x)** for variables. **Add Node** shows the same icon on each row, in the node's title bar colour. Material, Particle, Animation Graph and Behaviour Tree nodes have icons of their own, such as a sphere for **Material Output** and a flame for **Emitter Output**.
- **Tooltips:** hover a node's title for a second to see what it does, or a pin name with a dotted underline to see what the pin is for. On touch, tap it. Class graphs and Particle Graphs show them where the node or pin has a description.

## Add a node

Open **Add Node** in any of these ways:

- Double-tap or right-click (long-press on touch) empty canvas.
- Tap **Add Node** (**+**) in the graph toolbar. The node appears in the middle of the canvas, or in the nearest free spot when something is already there.
- Drag a wire from a pin and release it on empty canvas. The wire stays in place while **Add Node** is open, and the new node connects to that pin; closing the menu removes the wire.

Type in **Search Nodes** or browse the categories. Search words can be in any order and spaces are optional, so **Int to String** finds **To String (Int)** and **BeginPlay** finds **Event Begin Play**. The best match comes first: node names before aliases (such as **label** for **Set Text**), and those before descriptions. Categories are listed by their best match, and the highlighted first row is the one **Enter** adds. **Context Sensitive** is on by default. Without a dragged pin, it hides nodes that need a target object from another class. When you drag from a pin, it shows only nodes that connect to it, and a node whose **Target** you must connect (one that does not use Self when left empty) only when you drag from an object that fits that Target: dragging a Material does not offer a Cable's **Set Material**, and dragging an exec wire does not offer **Set Light Intensity**. Dragging from an object lists that object's own variables and functions first, then those it inherits; a reference to your own Class or one it inherits from offers its variables too. Turn Context Sensitive off to see every node the graph allows.

In Class, Material and Particle graphs, Add Node learns from the nodes you add from a pin. Once you add the same node from the same pin on the same kind of node twice, it moves to the top of the list the next time you drag from that pin, with up to five learned nodes listed first. Choices you stop making gradually lose their place. The list without a dragged pin always keeps its default order. History is kept on this device only.

## Connect pins

- Drag from one pin to another. With **Tap To Connect Pins** on in **Engine Settings > Accessibility**, you can also tap a pin and then a pin on the other side, starting from either one. Tap the first pin again to cancel, or tap another pin on the same side to choose it instead. Tapping anything else, dragging a node, opening a menu or pressing Esc also cancels it; you can still pan and zoom to reach the other pin.
- A data input takes one wire. Connecting a new wire replaces the old one.
- An execution output drives one wire; an execution input accepts several. Connecting a second wire from an execution output replaces the first and shows **Replaced the existing wire. Use a Sequence to run several.** To run several nodes in order, wire the output to a [Sequence](class/sequence.md).
- While you drag a wire over a pin it cannot connect to, a label gives the reason, such as **Float does not connect to Vector3**.
- Most unconnected data inputs show an inline value you can edit on the node or in the **Inspector**. Object and actor inputs must be wired, unless the node's page says an unconnected one uses the actor running the graph.
- Shake a node while dragging it to disconnect all its wires.

The graph toolbar also has icon buttons for **Copy**, **Paste**, **Delete**, **Break Links** (removes the wires of the selected nodes), **Cut Links** (see [Cut Links](#cut-links)) and **Format** (tidies the selected chains); hover or long-press one to see its name. The zoom controls at the bottom left show the zoom level; tap it to return to 100%.

Where a node can be renamed, such as a custom event or an Animation Graph state, double-click its title (double-tap on touch) to edit the name in place; press Enter to keep it or Esc to cancel.

Right-click a node (long-press on touch) for a menu with **Copy**, **Paste**, **Duplicate**, **Delete** and **Break Links**, plus actions such as **Rename Event** where they apply. Opening the menu on an unselected node selects only that node; opening it on a selected node keeps the whole selection. **Paste** and **Duplicate** add new nodes with the same values and the wires that ran between the copied nodes, offset from the originals. Nodes a graph protects, such as a function's **Input** and **Output**, cannot be copied, duplicated or deleted. Events keep their one place on the graph: a copied custom event gets a new name, and an event the graph already has is left out, as described in [Copy and duplicate events](events.md#copy-and-duplicate-events). The same actions have keyboard shortcuts: <kbd>Mod</kbd>+<kbd>C</kbd>, <kbd>Mod</kbd>+<kbd>V</kbd>, <kbd>Mod</kbd>+<kbd>D</kbd> and <kbd>Delete</kbd> or <kbd>Backspace</kbd> ([Keyboard Shortcuts](../start/shortcuts.md)). Gestures are listed in [Touch gestures](../start/gestures.md).

## Reroute nodes

A **Reroute** node is a small knot that bends a wire around other nodes. Double-click a wire, or double-tap it on touch, to split it with a knot at that spot, then drag the knot where you want the wire to run. You can also add **Reroute** from **Add Node** and wire it like any node.

- A knot takes the type of the wire it carries: any data type, or execution in Class graphs. Its pins show that type's colour and shape.
- Knots are available in Class, Scene, Animation Object, transition rule and state pose graphs, and in Particle Graphs. Material graphs use Named Reroutes instead ([Material](../assets/material.md#named-reroutes)).
- Knots change only how the graph looks. They cost nothing when the game runs and the debugger never stops on one; hovering a pin or wire next to one shows the value of the wire's real source.

## Cut Links

**Cut Links** in the graph toolbar turns on a tool for removing wires; the pointer becomes a blade. While it is on:

- Click or tap a wire to remove it.
- Click or tap a pin to remove every wire on it.
- Click or tap a Reroute knot to delete it with its wires.

What a click would remove turns red as you hover it. Other nodes and the canvas work as usual, so you can still select, move and pan. Press **Cut Links** again, or <kbd>Esc</kbd>, to turn the tool off; its shortcut is <kbd>Alt</kbd>+<kbd>X</kbd>. To have it turn off after each cut, set **Cut Links Tool** to **One Use** in **Engine Settings > Graph**.

**Engine Settings > Graph** controls **Add Node History**, **Read-Only Pin Defaults**, **Cut Links Tool** and **Graph Default Zoom**. **Engine Settings > Accessibility** controls the **Node Connection Assistant** (suggests wires when you move a node near compatible pins), its **Connection Distance (Pixels)** (48 by default), **Shake Nodes To Disconnect**, **Snapped Nodes**, and pin options such as **Large Pins** and **Pin Type Letters**; see [Accessibility](../editor/settings.md#accessibility). Turning **Add Node History** off restores the default order and stops learning without deleting what was learned; **Clear Add Node History** deletes it.

## Compile and play

Graphs are checked as you edit. Problems appear in **Compiler Results**, and each node with errors shows a red badge above it with its error count; tap a result to jump to the node. The result stays selected, with its details below the list, until you select something else; tap it again at any time to jump back to the node. Double-tap a result to open the Event Graph or function that holds the node, even when another window covers it. Right-click or hold a result for **Open**, **Copy Error** (or **Copy Warning**) and **Copy Details**.

1. Tap **Compile** in the toolbar, or press <kbd>F7</kbd>. **Compiler Results** lists the errors and warnings of the class you have open, and **Compilation Error** appears next to the button while it has errors.
2. Press Play. Play compiles the graphs the game uses: the scene it starts in, the Game Instance, the Game and Scene Subsystems, and every class they use. Other classes are not checked.
3. If any of those graphs has errors, the **Compile errors** dialog lists them. Tap a row to go to the node, or choose **Play Anyway**.

Warnings never block Play. A loop that never ends stops Play and reports **Infinite loop detected**.

Play also lists the warnings of every class it compiled in the **Compiler Results** of the document you played from, grouped by class. Tap one to see its details; double-tap it, or choose **Open** from its menu, to open that class at the node. Each open document keeps its results while you work in another, so you can go through them one by one; the next Play or Compile replaces them.

To see a class run, start a Simulation with the class open: the nodes that run light up for the object you pick, and pins show their last values ([Watch a graph run](../debugging/index.md#watch-a-graph-run)). Behaviour Trees and Animation Graphs can be watched the same way.

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
- [Scene Scripts](scene-scripts.md)
- [Editor Scripting](editor-scripting.md)
- [Execute JavaScript](javascript.md)
