# Prefab

A reusable set of components without logic. Lighter than an Actor [Class](class.md): no graph, events, variables or tick.

## Create

In the **Content Browser**, choose **New Asset > World > Prefab**. A new Prefab holds one Box mesh, or nothing if the open Scene is 2D.

## Editor

Double-tap a Prefab to open it.

- **Prefab**: a viewport that previews the components. Select one to move it with the gizmo.
- **Components**: the component tree, with a search field. **+** adds a part to the selected component. Each row's **…** menu (or right-click or long-press) offers **Add Child Component**, **Rename** and **Delete**; Delete also removes the selected components. Drag a component onto another to attach it.
- **Inspector**: the selected component's transform and settings.

The **Prefab Root** row is the actor's origin: the point that sits at the actor's position in a Scene. Select it and drag the gizmo to move the origin relative to the components.

## Notes

- Place a Prefab from **Place Actors**, under **Content > Project**. Editing the Prefab updates every placed copy.
- Prefabs do not accept your scripted Actor Component classes. Use an Actor Class for those.
- [Spawn Actor](../scripting/class/spawn-actor.md) creates actors from a Class, not from a Prefab.

## Related

- [Prefabs](../scenes/prefabs.md)
- [Actors](../scenes/actors.md)
- [Class](class.md)
