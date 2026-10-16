# Spline

An editable 3D path with smooth curves and optional closed loops.

## Add it

Select an actor, then choose **Add Component > General > Spline**.

## Settings

| Setting | Description |
| --- | --- |
| Closed Loop | Joins the last point to the first. Needs at least three points. Default off. |
| Curvature | 0 joins points with straight segments. 1 bends the path smoothly through every point. Default 1. |
| Path Point Count | Number of points, 2 to 128. New points continue 5 units along Z from the last one. Default 2. |
| Path Point 1, 2, ... | The position of each point in the component's local space. |

## Edit in the viewport

Choose **Edit In Viewport** on the component card, then:

- Drag a point to move it. With a point selected, the translate gizmo moves it.
- Drag the small handle at the middle of a segment to add a point.
- Double-click a point to remove it.

Tap anywhere else in the viewport to give the gizmo back to the actor. The Spline also follows the actor's and component's transforms.

## Notes

- World scenes only.
- A Spline is a drawing aid in the editor. It does not draw in Play.

## Related

- [Geometry](../graphics/geometry.md)
- [Water River](water-river.md) uses the same path controls.
