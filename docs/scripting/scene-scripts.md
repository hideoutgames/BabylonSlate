# Scene Scripts

A Scene and a Scene Layer can each carry a script of their own: the **Scene Script** and the **Scene Layer Script**. They work like an Object [Class](classes.md) graph, with events, functions and variables, but they have no Prefab or components and no asset of their own. They belong to the Scene or Scene Layer and are saved with it, and you cannot create them anywhere else.

## Open a script

1. Open the Scene or Scene Layer.
2. In the toolbar, set **Scene Mode** to **Script**. A Scene offers **Design**, **Landscape**, **Foliage** and **Script**; a Scene Layer offers **Design** and **Script**.
3. Script mode shows the **Event Graph**, the **Script** panel with its variables, functions and events, the **Inspector** and **Compiler Results**. **Design** returns to the viewport.

A new script starts with [Event Begin Play](class/event-begin-play.md) and [Event Tick](class/event-tick.md). Add **Event Destroyed** ([Event On Actor Destroyed](class/event-on-actor-destroyed.md)) from the **Script** panel's events to clean up.

## When the script runs

| Script | Runs |
| --- | --- |
| Scene Script | Once per loaded copy of the Scene: the Scene Play starts in or changes to, and each copy a [Scene Streaming](../scenes/streaming.md) actor loads. |
| Scene Layer Script | Once per copy of the layer. Two copies of the same layer each run their own script with their own variables. |

- **Begin Play** runs when the Scene or layer has finished loading, so its actors exist. It runs before those actors' own Begin Play.
- **Tick** runs every simulation step while the Scene or layer is running. It pauses with the game.
- **Destroyed** runs when the Scene unloads (Change Scene, or a streamed Scene unloading) or when the layer is removed. A layer that belongs to a Scene is removed with it.
- Self is the Scene, or the Scene Layer copy. A Scene Layer Script can pass itself to the Scene Layer camera nodes, and its physics queries see only its layer.

## Reach your actors

Add Node lists, under **Scene Actors**, one Get node for each actor the Scene or layer places and one for each component on those actors:

| Node | Returns |
| --- | --- |
| [Get Scene Actor](class/get-scene-actor.md) | The actor, titled with its name: **Get Player Start**. |
| [Get Scene Actor Component](class/get-scene-actor-component.md) | A component of that actor, titled with both names: **Get Point Light (Lamp)**. |

They always return this copy's own actor, never one with the same name in another Scene or layer copy. Renaming an actor or component renames the nodes. If you delete the actor or component, the node shows an error until you remove it.

## Related

- [Scene](../assets/scene.md)
- [Scene Layers](../scenes/scene-layers.md)
- [Classes](classes.md)
- [Events](events.md)
