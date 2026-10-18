# Prefabs

A prefab is a reusable set of components that you place many times. Edit the prefab once and every placed copy in your scenes follows.

Haptic has two kinds:

| Kind | Use it for |
| --- | --- |
| **Prefab** asset | Props and scenery with no logic: a lamp post, a crate, a tree. It has no graph, events, variables or tick, so it costs less than a Class. |
| Actor **Class** | Anything with behaviour. The Class's components are its prefab, and its graph runs on every copy. |

## Make a Prefab asset

1. In the **Content Browser**, choose **New Asset > World > Prefab**. A new Prefab holds one Box mesh, or nothing if the open Scene is 2D.
2. Double-tap it. The editor shows the **Prefab** viewport, the **Components** list and the **Inspector**.
3. Tap **+** in **Components** to add a part. It attaches to the selected component, or to **Prefab Root** when that is selected; the button's tooltip and the menu title name the target. Drag a component onto another to attach it.
4. Open a row's **…** menu, or right-click or long-press the row, for **Add Child Component**, **Rename** and **Delete**. Press Delete to remove the selected components. Use the search field to find a component by name.
5. Select a component to edit its transform and settings in the **Inspector**, or move it with the gizmo in the viewport.

Prefab assets do not accept your scripted Actor Component Classes; use an Actor Class for those.

## Prefabs on a Class

A Class whose parent is **Actor** (or a child of it) opens with a **Prefab** tab beside the **Event Graph**, and a **Components** list. Build the components there the same way. A child Class shows its parent's components too; you can edit them but not remove them. See [Classes](../scripting/classes.md).

## Prefab Root and the pivot

The **Prefab Root** row is the actor's origin: the point that sits at the actor's position in a scene. Select it and drag the gizmo to move the origin relative to the components. The components stay where they are.

On a Class, selecting **Prefab Root** also shows the **Parent Class** and **Actor Defaults** in the **Inspector**.

## Place a prefab

Open a scene, tap **+** in the **Outliner** and find the Prefab or Class under **Content > Project** in **Place Actors**. Classes that belong in [Scene Layers](scene-layers.md) appear only when a Scene Layer is open.

## How copies stay in sync

- Editing a prefab updates every placed copy in the open scene straight away, as an undoable scene edit.
- Other scenes update the next time you open them. The scene is then marked as changed; save it to keep the update.
- Changing a component's setting on a placed copy makes that setting an override. Later prefab edits no longer change it. Use the field's reset button to return to the prefab's value.
- Components you add to a placed copy stay on that copy. Components you remove from a copy stay removed, even if the prefab still has them.
- A copy's name, position, rotation, scale, parent and folder always belong to the copy.

## Prefabs in scripts

[Spawn Actor](../scripting/class/spawn-actor.md) creates actors from a Class, not from a Prefab asset. If you need to create copies during Play, build the prefab on an Actor Class.

## Related

- [Prefab](../assets/prefab.md)
- [Actors](actors.md)
- [Class](../assets/class.md)
