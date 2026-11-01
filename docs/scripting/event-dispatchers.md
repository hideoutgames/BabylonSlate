# Event Dispatchers

An Event Dispatcher lets an object announce that something happened without knowing who is listening. Other objects bind their custom events to it, and one **Call** runs every bound event. It works like Unreal Engine's Event Dispatchers.

For example, an **Enemy** class declares **On Damaged** with a **Damage** input. A health bar binds its own custom event to the enemy's **On Damaged** in **Event Begin Play**. Whenever the enemy calls **On Damaged**, the health bar's event runs with the damage, and the enemy never names the health bar.

## Add an Event Dispatcher

1. In the **Class** window, tap **+** next to **Event Dispatchers**.
2. Type a name, such as **On Damaged**, and press <kbd>Enter</kbd>.
3. With the dispatcher selected, add **Inputs** in the **Inspector** for the values it passes to the bound events.

| Setting | Description |
| --- | --- |
| Name | The dispatcher's name, shown on its nodes. Renaming it updates this class's nodes. |
| Category | Groups dispatchers into folders in the **Class** window. |
| Copy Signature From | Copies the inputs of a function, a custom event or another Event Dispatcher. The copy is made once; later changes to the source do not follow. |
| Inputs | The values each Call passes. Integer, Float and Vector inputs can have a **Unit**. |

Changing the inputs updates every Call, Bind and Unbind node for the dispatcher in this class, and the custom events bound to them. Deleting the dispatcher removes those nodes.

Child classes inherit their parents' dispatchers. A child cannot declare a dispatcher with a name its parents already use. Function Libraries have no Event Dispatchers, and [Scene scripts](scene-scripts.md) can bind to other objects' dispatchers but not declare their own.

Some engine objects have events of their own: a [Timeline Clip](../scenes/timeline.md#bind-to-a-clips-events) has **On Finished**, **On Looped** and one event per Custom Event Track. Scripts bind them with the same nodes; only the engine calls them, so they have no **Call** node.

## Add its nodes

Drag a dispatcher from the **Class** window onto the graph and choose one of:

| Choice | Adds |
| --- | --- |
| **Call** | [Call Event Dispatcher](class/call-event-dispatcher.md), which runs every bound event. |
| **Bind** | [Bind Event to Event Dispatcher](class/bind-event-to-event-dispatcher.md), which adds an event. |
| **Unbind** | [Unbind Event from Event Dispatcher](class/unbind-event-from-event-dispatcher.md), which removes an event. |
| **Unbind All** | [Unbind All Events from Event Dispatcher](class/unbind-all-events-from-event-dispatcher.md), which removes every event. |
| **Event** | A custom event that takes the dispatcher's inputs, named after it: **Event On Damaged**, or **Event On Damaged_1** when the class already has an event of that name. |
| **Assign** | A Bind node and such a custom event, already wired together. |

**Event** and **Assign** add a custom event, so they are offered only in the Event Graph. **Add Node** lists the same nodes under **Event Dispatchers**, named after the dispatcher, such as **Call On Damaged** and **Assign On Damaged**. To use another object's dispatcher, drag from a pin that holds that object; the nodes get a **Target** pin. For a dispatcher of this class, **Target** shows **Self** while it is unconnected.

## Bind a custom event

Every custom event has a square **Output Delegate** pin at the right end of its title bar. Connect it to the **Event** input of a Bind or Unbind node.

- A custom event with no outputs takes the dispatcher's inputs when you connect it, names included.
- A custom event whose outputs do not match the dispatcher cannot be connected. The wire shows why, for example **Delegate (Float, String) does not connect to Delegate (Float)**.
- While it is connected, the event's **Outputs** in the **Inspector** cannot be edited, and the **Inspector** shows **Signature From: On Damaged (Enemy)**. Disconnect it to edit them again.

To bind a function, or an event of another object, use [Create Event](class/create-event.md) instead. Dragging from a Bind node's **Event** input offers **Add Custom Event for On Damaged**, which adds **Event On Damaged** named like the **Event** choice, and **Create Event for On Damaged**, both connected on release.

## Delegate values

A delegate pin is a square. While it is unconnected it is dark red inside a light red border; once connected the colours swap, light red inside a dark red border.

**Delegate** is also a type you can pick for variables, local variables, function inputs and outputs, custom event outputs, Event Dispatcher inputs, Script Interface pins and Execute JavaScript pins. After picking it, choose its **Signature**: an Event Dispatcher whose inputs it takes, or **No Inputs**. A function can then take a listener as an input and bind it itself. See [Pin Types](pin-types.md).

## How a Call runs

- Each bound event runs in the order it was bound, straight away, and then **Out** continues. Latent nodes inside a bound event do not hold up the Call.
- Each bound event receives the Call's values in order, under its own input names.
- Binding the same event of the same object twice keeps one binding. Unbind removes it whichever node bound it.
- A Call with nothing bound does nothing.
- A bound event of an object that has been destroyed is skipped and removed. A destroyed object's own dispatchers lose their bindings, after its **Event On Actor Destroyed** has run.
- A bound event still waiting on a latent node such as [Delay](class/delay.md) is skipped, like any custom event called while it waits.
- Events bound or unbound during a Call take effect from the next Call, except that an event unbound during a Call is not run later in that Call.
- A dispatcher called again from its own bound events stops after 64 levels and reports an error in the **Output Log**.
- An empty **Target** or **Event** does nothing and reports an error such as `Health Bar: Bind Event to On Damaged (Target) tried to access null.`.
- Bindings last until the object is destroyed or Play stops. They are not saved in [Save Games](save-games.md). The Game Instance and subsystems keep theirs across scene changes.
