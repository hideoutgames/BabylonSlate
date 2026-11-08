# Class

A class with a parent and a logic graph: the variables, functions and events of an actor, a component, a game object or an editor tool.

## Create

1. In the **Content Browser**, choose **New Asset > Scripting > Class**.
2. Enter a **Name**.
3. Pick a **Parent Class** from the list. Use **Search Classes** to filter it. Engine classes come first; your own classes sit under the class they inherit from.
4. Choose **Create**.

Classes can inherit up to 16 levels deep. A class at that depth cannot be picked as a parent.

From the **Content Browser** asset menu you can also:

- Right-click a Class and choose **Create Child Class** for a Class that inherits from it.
- Select Models, Sprites and Particle Systems, right-click one and choose **Create Actor** for an Actor Class with a component for each.

See [Create from assets](../editor/content-browser.md#create-from-assets).

## Editor

Double-tap a Class to open it.

- **Event Graph**: the class's events. Each function opens in its own tab beside it.
- **Class**: the class's **Functions**, **Variables**, **Events** and **Interfaces**. Use **+** on a section to add one. Inherited members carry an **Inherited** badge.
- **Inspector**: the selected node or member.
- **Compiler Results**: errors and warnings for this class.
- **Prefab** and **Components**: for classes that descend from Actor. Build the actor's components here. A Class whose components you have not edited places as a Box mesh in a 3D Scene, and as an empty actor in a 2D Scene or a Scene Layer. A Scene Layer Actor Class starts with no components, and its Prefab has a **Frame** menu ([Scene Layers](../scenes/scene-layers.md#create-and-edit-a-layer)).

Classes that do not descend from Actor, such as Actor Component and Function Library classes, open without **Prefab** and **Components**.

## Settings

The **Inspector** shows the class settings while nothing is selected, and when you select **Prefab Root** in **Components**.

| Setting | Description |
| --- | --- |
| Parent Class | The class this one extends. Only actor parents are offered. |
| Generate Hit Events | Turn off to stop **Event On Hit** for this actor. Physics still simulates. |
| Generate Overlap Events | Turn off to stop the overlap events for this actor. |
| Event Tick | **Inherit**, **Enabled** or **Disabled**. Disabled stops the actor's [Event Tick](../scripting/class/event-tick.md); its components keep ticking. |
| Tick On Pause | Off by default. Turn on to keep the actor, its components, Delays, tweens and sounds running while the game is paused by [Set Game Paused](../scripting/class/set-game-paused.md). |

Parent Class and Actor Defaults appear for actor classes. Some parents add their own fields, such as the Scene Layer Actor Switcher.

For a class whose parent is a Game Instance class, the **Inspector** shows **Game Instance Defaults** with **Tick On Pause** instead: off by default, it keeps the Game Instance ticking while the game is paused.

## Related

- [Classes](../scripting/classes.md)
- [Prefab](prefab.md)
- [Scripting](../scripting/index.md)
- [Spawn Actor (Async)](../scripting/class/spawn-actor-async.md)
- [Spawn Actor (Blocking)](../scripting/class/spawn-actor-blocking.md)
