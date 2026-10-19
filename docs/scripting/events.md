# Events

Events start execution chains. The engine fires lifecycle events, components fire their own events, and you can define custom events that graphs call by name.

## Add an event

In the **Class** window, tap **+** next to **Events**. The **Add Event** menu lists:

- **New Event**, which creates a custom event.
- The lifecycle events of the class, listed below.
- Events of the class's components, such as **Event On Click (2D Button)** or **Event On Hit (Collider)**. Each component gets its own event.
- Custom events inherited from the parent class.

Each event can be on the graph only once. The **Events** section lists the events on the graph; tap one to jump to it. A second copy, such as two **Event Tick** nodes or two custom events with the same name, is a compile error. Keep one and use a [Sequence](class/sequence.md) to run several chains. Component events count per component, and input events per Input Action or Input Axis.

Copying an event never breaks this rule; see [Copy and duplicate events](#copy-and-duplicate-events).

## Lifecycle events

| Parent class | Events |
| --- | --- |
| **Actor**, **ActorComponent** | [Event Begin Play](class/event-begin-play.md), [Event Tick](class/event-tick.md), [Event On Actor Destroyed](class/event-on-actor-destroyed.md) (called **Event Destroyed** on components), [Event On Game Loaded](class/event-on-game-loaded.md), [Event Scalability Changed](class/event-scalability-changed.md) |
| **GameInstance**, **GameSubsystem** | [Event On Init](class/event-on-init.md), Tick, [Event On End](class/event-on-end.md), On Game Loaded, Scalability Changed, [Event On First Scene Loaded](class/event-on-first-scene-loaded.md), [Event On Scene Start Loading](class/event-on-scene-start-loading.md), [Event On Scene Finish Loading](class/event-on-scene-finish-loading.md), [Event On Scene Exit](class/event-on-scene-exit.md) |
| **SceneSubsystem** | On Init, Tick, On End, On Game Loaded, [Event On Scene Loaded](class/event-on-scene-loaded.md), [Event On Streamed Scene Loaded](class/event-on-streamed-scene-loaded.md), [Event On Streamed Scene Unloaded](class/event-on-streamed-scene-unloaded.md), [Event On Scene Layer Added](class/event-on-scene-layer-added.md), [Event On Scene Layer Removed](class/event-on-scene-layer-removed.md), [Event On Scene Actor Spawned](class/event-on-scene-actor-spawned.md), [Event On Scene Actor Destroyed](class/event-on-scene-actor-destroyed.md) |
| **BDebugCommand** | [Event On Command Run](class/event-on-command-run.md) |
| **EditorUtilityObject** | [Event Editor On Begin Play](class/event-editor-on-begin-play.md), [Event On Editor Startup](class/event-on-editor-startup.md), [Event On Scene Open](class/event-on-scene-open.md), [Event On Scene Saved](class/event-on-scene-saved.md), [Event On Editor Shutdown](class/event-on-editor-shutdown.md) |
| **BTTask** | [On Activate](class/on-activate.md), [On Tick](class/on-tick.md), [On Abort](class/on-abort.md) |
| **BTDecorator** | [On Evaluate](class/on-evaluate.md) |
| **BTService** | On Tick |

When the Game Instance and subsystem events fire is described in [Game Instance and Subsystems](game-instance.md). Input events such as [Event Input Action](class/event-input-action.md) come from **Add Node**; see [Input](../input/index.md).

## Custom events

1. Tap **+** next to **Events** and choose **New Event**. Type a name.
2. With the event selected, add **Outputs** in the **Inspector** for the values it receives. Integer, Float and Vector outputs can have a **Unit**, shown on the Call node's value field. Use **Rename Event** to rename it together with its calls in this class.
3. To run it, drag the event from the **Class** window onto the graph, or choose **Call** followed by its name in **Add Node**. This places a [Call Custom Event](class/call-custom-event.md) node with one input per output. Select several entries to drop a node for each.

To run a custom event on another object, drag from a pin that holds that object and choose its Call entry; the node gets a **Target** pin. For an event of this class the pin reads **Target (Self)** while it is unconnected, so the event runs on the running object; connect another object of the class to run it there. The caller continues straight away and does not wait for latent nodes inside the event.

A child class can override an inherited custom event by adding it from **Add Event**. It comes wired to [Call Parent Event](class/call-parent-event.md), which runs the parent's version.

## Copy and duplicate events

**Paste** and **Duplicate** (<kbd>Mod</kbd>+<kbd>D</kbd>) copy a selection of nodes as new nodes with the same values and the wires between them. For events, each one stays on the graph once:

- A custom event gets a new name: **Open Door** becomes **Open Door Copy**, then **Open Door Copy 2**. It never repeats the name of another custom event in the class, in this graph or a function graph. Calls to the original keep calling the original. A copy keeps its name only when no other custom event uses it, such as after you delete the original.
- An event that cannot be renamed, such as **Event Tick**, **Event Begin Play**, a component event or an input event, is left out when the graph already has it. The wires to and from it are dropped, the rest of the selection is still pasted, and a notice such as **Event Tick is already in this graph.** appears for a few seconds. Pasting it into a graph without that event adds it.

## Copy events between classes

Select events in the **Class** window, choose **Copy**, then choose **Paste** in any **Class** window. Only the event node is copied, not the nodes it runs. A custom event is pasted with a free name, such as **Open Door 1**. A native event such as **Event Begin Play** is pasted as that event when the class does not have it yet, and otherwise as a custom event named like a duplicate, **Begin Play 1** (then **Begin Play 2**). See [Select, copy and paste members](classes.md#select-copy-and-paste-members).

## Actor Defaults

For actor classes, select **Prefab Root** in **Components**. **Actor Defaults** in the **Inspector** controls which events reach the class's scripts:

| Setting | Description |
| --- | --- |
| Generate Hit Events | Turn off to stop **Event On Hit** for this actor. Physics still simulates. |
| Generate Overlap Events | Turn off to stop the overlap events for this actor. |
| Event Tick | **Inherit**, **Enabled** or **Disabled**. Disabled stops the actor's **Event Tick**; its components keep ticking. |

## Notes

- **Event Tick** passes **Delta Seconds**, the simulation time since the previous tick.
- If an event is still waiting on a latent node such as [Delay](class/delay.md), new runs of that event on the same object are skipped until it finishes. This keeps **Event Tick** from piling up.
- Collision events need a [Collider](../components/collider.md); see [Collision](../physics/collision.md).
