# Class

A class with a parent and a logic graph: the variables, functions and events of an actor, a component, a game object or an editor tool.

## Create

1. In the **Content Browser**, choose **New Asset > Scripting > Class**.
2. Enter a **Name**.
3. Pick a **Parent Class** from the list. Use **Search Classes** to filter it. Engine classes come first; your own classes sit under the class they inherit from.
4. Choose **Create**.

Classes can inherit up to 16 levels deep. A class at that depth cannot be picked as a parent.

## Editor

Double-tap a Class to open it.

- **Event Graph**: the class's events. Each function opens in its own tab beside it.
- **Class**: the class's **Functions**, **Variables**, **Events** and **Interfaces**. Use **+** on a section to add one. Inherited members carry an **Inherited** badge.
- **Inspector**: the selected node or member.
- **Compiler Results**: errors and warnings for this class.
- **Prefab** and **Components**: for classes that descend from Actor. Build the actor's components here.

Classes that do not descend from Actor, such as Actor Component and Function Library classes, open without **Prefab** and **Components**.

## Settings

Select **Prefab Root** in **Components** to show the class settings in the **Inspector**.

| Setting | Description |
| --- | --- |
| Parent Class | The class this one extends. Only actor parents are offered. |
| Generate Hit Events | Turn off to stop **Event On Hit** for this actor. Physics still simulates. |
| Generate Overlap Events | Turn off to stop the overlap events for this actor. |
| Event Tick | **Inherit**, **Enabled** or **Disabled**. Disabled stops the actor's [Event Tick](../scripting/class/event-tick.md); its components keep ticking. |

Parent Class and Actor Defaults appear for actor classes. Some parents add their own fields, such as the Scene Layer Actor Switcher.

## Related

- [Classes](../scripting/classes.md)
- [Prefab](prefab.md)
- [Scripting](../scripting/index.md)
- [Spawn Actor](../scripting/class/spawn-actor.md)
