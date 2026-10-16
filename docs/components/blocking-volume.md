# Blocking Volume

An invisible solid box that stops physics bodies, shaped by the actor's transform.

## Add it

Choose **Place Actors > Physics > Blocking Volume**. It is not in the **Add Component** menu.

## Settings

A Blocking Volume has no settings of its own. Move, rotate and scale the actor to shape the box.

## Notes

- Works in world scenes and in Scene Layers.
- In the editor it appears as a blue dotted box. It is hidden in Play and exports.
- It is solid without a Rigid Body or Collider, and it never moves.
- Navigation ignores it. To block paths, use a [NavMesh Blocker](nav-mesh-blocker.md).
- The Inspector lists it as Blocking Volume Component.

## Related

- [Collision](../physics/collision.md)
- [Collider](collider.md)
