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

## Inheritance

A class inherits its parent's variables, functions, events, interfaces and components.

- Inherited members appear in the **Class** window with an **Inherited** badge. Double-tap one, or choose **Open Parent Class** from its context menu, to edit it in the parent.
- To let child classes replace a function, turn on **Overridable** for it in the parent. The child then picks it from the **Functions** **+** menu.
- A new class's starting events, and inherited custom events you add from the **Events** **+** menu, come wired to a [Call Parent Event](class/call-parent-event.md) node so the parent's logic still runs. Delete that node to replace the parent's behaviour.
- To change an actor class's parent, select **Prefab Root** in **Components**, then choose **Parent Class** in the **Inspector**. Only actor parents are offered.
- Classes can inherit up to 16 levels deep.

Use [Cast To](class/cast-to.md) to treat an object as one of its subclasses.

## Console commands

A **BDebugCommand** class adds a command to the Play console.

1. Create a Class with **BDebugCommand** as its parent. Its graph starts with [Event On Command Run](class/event-on-command-run.md).
2. Select that event and set **Command Name**, **Description**, **Category** and **Parameters** in the **Inspector**. Each parameter becomes an output pin.
3. Finish the logic with [Report Command](class/report-command.md) to send a success flag and a message back to the console.

Your commands are included in every exported game, so [Execute Console Command](class/execute-console-command.md) can run them anywhere. Names used by built-in commands are reserved. See [Console](../debugging/console.md).
