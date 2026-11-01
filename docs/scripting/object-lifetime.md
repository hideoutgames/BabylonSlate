# Objects and lifetime

Every object in a game is either owned or collected:

- **Owned objects** are actors and their components, Scenes and Scene Layers, the Game Instance and subsystems. Each lasts until something ends it: [Destroy Actor](class/destroy-actor.md), a Scene unloading, a Scene Layer being removed, or Play stopping. A reference to one never keeps it alive.
- **Collected objects** are the objects you make with [Create Object](class/create-object.md). Each one lives while something still refers to it, and Haptic removes it once nothing does.

## Create an object

1. Make a Class whose **Parent Class** is **Object**; see [Classes](classes.md).
2. In another graph, add [Create Object](class/create-object.md) and pick that Class. Its **Object** output has the Class's type, so you can read its variables and call its functions and events.
3. Store the result in a variable to keep the object. To let it go, set every variable that holds it to an empty reference.

Create Object runs the new object's [Event On Init](class/event-on-init.md) before it returns. Created objects have no transform, no components and no Begin Play.

Only a Class whose parent is **Object** can be created this way. Picking an Actor, a component, the Game Instance, a subsystem or another engine class is an error in **Compiler Results**; use [Spawn Actor](class/spawn-actor.md) for actors.

## Tick

A created object does not tick unless its Class implements the **Tickable Object** interface:

1. In the Class's **Class** window, tap **+** next to **Interfaces** and pick **Tickable Object**. It is listed only for Classes whose parent is Object.
2. Add **Event Tick** from **Events +** or **Add Node**.

Ticking objects run after actors and components on every tick, in the order they were created. Ticking never keeps an object alive. Actors, components, the Game Instance and subsystems already have Event Tick, so adding Tickable Object to them is an error.

## What keeps an object alive

An object stays alive while it can be reached from an owned object through:

- Object variables, including the entries of arrays and maps (keys and values) and the fields of structures.
- Variables of other created objects that are themselves alive.
- An event or function that is waiting on a node such as a [Delay](class/delay.md): until it finishes, it keeps every value it has produced so far, including the output of a Create Object it ran.
- Behaviour Tree blackboard entries.

These never keep an object alive:

- Event Dispatcher bindings and Delegate values. A binding to an object that is collected is removed.
- References kept inside [Execute JavaScript](class/execute-javascript.md) code rather than in variables.

## Collection

Haptic checks which created objects are still reachable at the end of a tick, when no graph is running:

- about once a second while created objects exist or an actor was destroyed,
- when the main Scene changes,
- and at the end of the tick in which [Collect Garbage](class/collect-garbage.md) runs.

A collected object runs no events. Its waiting nodes stop, and every reference to it reads as empty.

## Destroyed and collected references

A reference to an object that was destroyed or collected counts as empty straight away:

- [Is Valid](class/is-valid.md) returns false, and [Validated Get](class/validated-get.md) and [Cast To](class/cast-to.md) take their not-valid paths.
- A node that acts on the object does nothing and logs an error ending `tried to access a destroyed object.`; see [Pin types](pin-types.md#empty-references).
- At the next check, variables, array entries and map values that still hold it are set to empty, and map entries whose key is that object are removed.

[Save games](save-games.md) store actor and component references only: saving a variable that holds a created object fails with an error.
