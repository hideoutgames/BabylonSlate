# Classes

A Class defines a kind of object: its parent class, variables, functions, events and, for actors, its components.

## Create a class

1. In the **Content Browser**, choose **New Asset > Scripting > Class**.
2. Enter a **Name**.
3. Pick a **Parent Class**. Engine classes are listed first; your own classes appear under the class they inherit from.
4. Choose **Create**, then double-tap the new asset to open it.

## Parent classes

The **Parent Class** list shows engine classes by their class names.

| Parent Class | Use it for |
| --- | --- |
| **BObject** | The root of every class. A class parented directly to it has no transform and is not placed in scenes. |
| **Actor** | Objects you place in a scene or create with [Spawn Actor](class/spawn-actor.md). Actors have a transform and components. |
| **RenderTargetCapture** | An actor that starts with a capture component. See [Render targets](../graphics/render-targets.md). |
| **SceneLayerActor** | Actors that live in a [Scene Layer](../scenes/scene-layers.md). |
| **SceneLayerActorSwitcher** | A Scene Layer actor that shows one of several Scene Layer actor classes at a time. |
| **SceneStreamingActor** | An actor that streams another scene in and out. See [Scene streaming](../scenes/streaming.md). |
| **ActorComponent** | Your own component. It appears under **Project** in **Add Component**, or add it with [Add Component](class/add-component.md). |
| **GameInstance** | The one object that lasts for the whole play session. See [Game Instance and Subsystems](game-instance.md). |
| **GameSubsystem**, **SceneSubsystem** | Objects the engine creates once per session or once per scene. See [Game Instance and Subsystems](game-instance.md). |
| **FunctionLibrary** | Functions that any graph can call. See [Functions](functions.md#function-libraries). |
| **BDebugCommand** | A console command. See [Console commands](#console-commands). |
| **EditorUtilityObject**, **EditorFunctionLibrary** | Tools that run only in the editor. See [Editor Scripting](editor-scripting.md). |
| **BTTask**, **BTDecorator**, **BTService**, **BTComposite** | Behaviour Tree nodes you script yourself. See [Behaviour Trees](../ai/behaviour-trees.md). |

For components without any logic, a [Prefab](../assets/prefab.md) is lighter than an Actor class.

## The Class editor

| Window | Contents |
| --- | --- |
| **Event Graph** | The class's events. Each function opens in its own tab beside it. |
| **Class** | The class's **Functions**, **Variables**, **Events** and **Interfaces**. Use **+** on a section to add one. |
| **Inspector** | Settings of the selected node or class member. |
| **Compiler Results** | Errors and warnings for this class. |
| **Prefab** | Actor classes only: a preview of the components with gizmos. |
| **Components** | Actor classes only: the component tree and **Add Component**. |

A new class starts with the events its parent uses most, such as [Event Begin Play](class/event-begin-play.md) and [Event Tick](class/event-tick.md) for actors.

## Select, copy and paste members

Select several entries in the **Class** window to drag, copy or delete them together.

| Do this | Result |
| --- | --- |
| Tap or click an entry | Select only that entry. |
| <kbd>Mod</kbd>-click an entry | Add it to the selection, or remove it. |
| <kbd>Shift</kbd>-click an entry, or <kbd>Shift</kbd>+<kbd>Arrow</kbd> | Select every entry from the last one you chose without <kbd>Shift</kbd>. Section and folder rows are skipped. |
| Two-finger tap an entry | The same range select, on touch. |
| Hold or right-click an entry | Open its menu. An entry that is not selected becomes the only selection; on a selected entry the menu acts on the whole selection. |

In the menu, **Deselect** takes an entry out of a selection. After you hold an unselected entry, **Select** adds it to what was selected before, which is how you build a selection on touch. The graph follows the entry you chose last, as it does for a single entry. **Rename**, **Get** and **Set** work on one entry at a time; **Delete** removes every selected entry as one undoable change.

**Drag to the graph.** Drag any selected entry onto a graph to add a node for every selected entry, stacked down from where you drop, as one undoable change. Variables ask **Get** or **Set** once for all of them. Entries that cannot be dropped, such as native events and Script Interfaces, are skipped and a notice names them.

**Copy and paste.** Choose **Copy** in the menu (<kbd>Mod</kbd>+<kbd>C</kbd> while the window has focus) for a selection of variables (including local and component variables), functions and events, in any mix. **Copy** is not offered when the selection includes a Script Interface. The copy stays until you copy again, so you can paste it into any other Class, or the same one: **Paste** is in the menu of any entry, section or empty space of any **Class** window (<kbd>Mod</kbd>+<kbd>V</kbd>). A paste is one undoable change and never moves the original.

- **Variables** keep their type, default value, category and other settings.
- **Local variables** go into the function that is selected in the target **Class** window, or else the function whose tab is open. With neither, they are left out and the notice names them.
- **Component variables** add a copy of their component to the target Class, with the same type and settings and a free name such as **Mesh_1**, numbered like a duplicated variable; the pasted variable stands for the new component. The copy is attached at the top of the Components tree, or under the copy of its parent when the parent was pasted too. Components that only a Scene Layer or only a world Class can have are left out of the other kind.
- **Functions** keep their inputs, outputs, local variables, nodes and wires. A copy no longer implements a Script Interface or overrides a parent function; the original still does.
- **Events** copy only the event node, not the nodes it runs. A custom event keeps its outputs. A native event is pasted as that event when the target's own Event Graph does not have it, even if a parent Class does: it comes wired to a [Call Parent Event](class/call-parent-event.md) node, like an event you add yourself, so the parent's logic still runs. If the Event Graph has it already, the Class cannot have it (such as **Event Begin Play** in a Game Instance), or it belongs to a component the target Class does not have, it is pasted as a custom event named like any duplicate, such as **Begin Play 1**, with the native event's values as its outputs. An override of an inherited custom event also comes wired to Call Parent Event. A variable or event pasted into a Function Library is left out.
- **Names** that are taken get the next free `_1`, `_2`, ... suffix, as when you duplicate an asset: **Health** becomes **Health_1**, and a custom event **Open Door** becomes **Open Door 1**. This also applies to a function's local variables.
- **Inside a copied function**, a variable, function or custom event it uses points to the copy that came in the same paste, even after a rename. Otherwise it points to the member of the target Class (or a parent) with the same name and type. If neither exists the node stays as it was and **Compiler Results** reports it; no member is created for it.
- New event nodes are placed below the nodes already in the Event Graph, and the pasted entries become the selection.

A notice names anything a paste left out.

## Inheritance

A class inherits its parent's variables, functions, events, interfaces and components.

- Inherited members appear in the **Class** window with an **Inherited** badge. Double-tap one, or choose **Open Parent Class** from its context menu, to edit it in the parent.
- To let child classes replace a function, turn on **Overridable** for it in the parent. The child then picks it from the **Functions** **+** menu.
- A new class's starting events, and the native events and inherited custom events you add from the **Events** **+** menu, come wired to a [Call Parent Event](class/call-parent-event.md) node so the parent's logic still runs. Delete that node to replace the parent's behaviour.
- To change an actor class's parent, select **Prefab Root** in **Components**, then choose **Parent Class** in the **Inspector**. Only actor parents are offered.
- Classes can inherit up to 16 levels deep.

Use [Cast To](class/cast-to.md) to treat an object as one of its subclasses.

## Console commands

A **BDebugCommand** class adds a command to the Play console.

1. Create a Class with **BDebugCommand** as its parent. Its graph starts with [Event On Command Run](class/event-on-command-run.md).
2. Select that event and set **Command Name**, **Description**, **Category** and **Parameters** in the **Inspector**. Each parameter becomes an output pin.
3. Finish the logic with [Report Command](class/report-command.md) to send a success flag and a message back to the console.

Your commands are included in every exported game, so [Execute Console Command](class/execute-console-command.md) can run them anywhere. Names used by built-in commands are reserved. See [Console](../debugging/console.md).
