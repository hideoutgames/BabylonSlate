# NavMesh Blocker

A box or cylinder that blocks navigation or makes it more costly. It is not a physical collider.

## Add it

Choose **Place Actors > Navigation > NavMesh Blocker**. It is not in the **Add Component** menu. The Inspector lists it as Nav Mesh Blocker Component.

## Settings

| Setting | Description |
| --- | --- |
| Dynamic | Applies the blocker at runtime, so it can move or be destroyed in Play. Default off. |
| Kind | **Box** or **Cylinder**. Default Box. |
| Area | **Unwalkable** removes the area from navigation. **Cost** keeps it walkable but makes crossing it more expensive. Default Unwalkable. |
| Cost | How much more expensive the area is to cross. Shown when Area is Cost. Above 1. Default 10. |

## Notes

- Works in world scenes and in Scene Layers.
- The actor's scale sets the size of the volume. A cylinder's X and Z scale are its diameters.
- A static Unwalkable blocker is baked into the [NavMesh](nav-mesh.md), so bake again after you change it.
- A Dynamic Unwalkable blocker cuts the mesh in Play. It needs a NavMesh baked with **Support Dynamic Obstacles**.
- A Cost blocker applies in Play. Agents choose cheaper routes around it when they can.
- The editor draws it as an amber dotted volume.

## Related

- [Navigation](../ai/navigation.md)
- [Blocking Volume](blocking-volume.md)
