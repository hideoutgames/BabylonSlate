# Deformer

Bends and squashes a Mesh with a lattice of control points, after animation.

## Add it

Select an actor that has a Mesh, then choose **Add Component > Rendering > Deformer**. A new Deformer starts disabled.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Applies the deformation. Default off. |
| Target Mesh | The Mesh component on this actor to deform. |
| Strength | Blends the offsets in, from 0 to 1. Default 1. |
| Resolution | Control points along X, Y and Z. Each is 2 to 4, with up to 64 in total. Default 2, 2, 2. Changing it resets the offsets. |
| Fit To Mesh | Fits the cage to the target's undeformed bounds. Default on. |
| Bounds Min, Bounds Max | The cage bounds in the target's local space. Shown when Fit To Mesh is off. Max must be greater than Min on every axis. |
| Control 0, 0, 0 and so on | One offset for each control point, named by its grid position, in the target's local units. |

## Notes

- World scenes only.
- The deformation is applied after skeletal animation and any Material vertex offsets.
- It is visual only. Collision and picking keep the original shape.
- If several Deformers target the same Mesh, only the first enabled one applies.
- Vertices outside the cage keep their positions. Turn off Fit To Mesh and widen the bounds if the mesh animates beyond its rest size.
- Scripts can change the cage with the component's **Set Control Point Offset** and **Reset Control Points** functions.

## Related

- [Geometry](../graphics/geometry.md)
- [Mesh](mesh.md)
