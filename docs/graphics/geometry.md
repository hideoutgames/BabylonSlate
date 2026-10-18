# Geometry

Beyond imported models and primitives, Haptic has components that draw paths, cables, deformed meshes, script-built meshes, outlines and 3D text.

| Component | Use it for | Add it from |
| --- | --- | --- |
| [Spline](../components/spline.md) | A 3D path | **Add Component > General** |
| [Cable](../components/cable.md) | Ropes, wires and hanging cables | **Place Actors > Environment**, **Add Component > Physics** |
| [Deformer](../components/deformer.md) | Bending and squashing a mesh with a cage | **Add Component > Rendering** |
| [Dynamic Runtime Mesh](../components/dynamic-runtime-mesh.md) | Meshes built by scripts during Play | **Add Component > Rendering** |
| [Outline](../components/outline.md) | A coloured silhouette around one actor | **Add Component > Rendering** |
| [3D Text](../components/text-3d.md) | Text in the world | **Place Actors > Environment**, **Add Component > Rendering** |

## Splines

A Spline is a path of 2 to 128 points in the component's local space.

- **Curvature** 0 joins points with straight segments; 1 bends the path smoothly through every point.
- **Closed Loop** joins the last point to the first. It needs at least three points.
- To edit in a scene, choose **Edit In Viewport** on the component. Drag a point to move it, drag a midpoint to add a point, and double-click a point to remove it. A selected point can also be moved with the Move gizmo.
- Type exact positions in the point rows in the **Inspector**.

Water Rivers use the same point editing; see [Water](water.md).

## Cables

A Cable is a simulated tube between its start (the component) and an end point.

| Setting | Default | Description |
| --- | --- | --- |
| **Cable Length** | 4 | Rest length. Longer than the gap between the ends makes it sag. |
| **Segments**, **Sides** | 16, 6 | Simulation detail and tube roundness. More of either costs more. |
| **Cable Width** | 0.05 | Tube diameter. |
| **Material**, **Tile Material** | None, 1 | The tube's Material and how often its texture repeats. |
| **Attach Start**, **Attach End** | On, On | Pin each end. Turn one off to let that end fall free. |
| **Target Actor**, **Target Component**, **End Position** | Self, none, (3, 0, 0) | Where the end attaches, as an offset in the target's space. |
| **Gravity Scale**, **Cable Force**, **Damping** | 1, 0, 0.03 | Forces on the cable and how quickly it settles. |
| **Enable Collision**, **Collision Friction** | Off, 0.2 | Lets the cable rest on colliders in Play. |

Cables also simulate gently in the editor, without collision. A stretched cable never pulls the actors it is attached to.

## Deformers

A Deformer bends one Mesh component on the same actor with a lattice cage, after animation and material vertex offsets.

1. Add a **Deformer**. It targets the actor's first Mesh and starts enabled; pick another in **Target Mesh** if needed.
2. Set **Resolution**: 2 to 4 control points per axis. Changing it resets the offsets.
3. Select the actor and drag the cage's control points in the viewport, or type the **Control** offsets. The mesh deforms as you edit. **Strength** blends the effect from 0 to 1.

**Fit To Mesh** fits the cage to the mesh. Turn it off to set **Bounds Min** and **Bounds Max** yourself. Deforming is visual only: collision and picking keep the original shape. Scripts can change the cage with the component's **Set Control Point Offset** and **Reset Control Points** functions.

## Dynamic Runtime Mesh

A Dynamic Runtime Mesh starts empty and gets its geometry from scripts during Play. Drag the component into a graph to find its functions:

| Function | What it does |
| --- | --- |
| **Set Geometry** | Replaces the mesh with positions, triangle indices and optional normals and UVs. |
| **Update Vertices** | Changes a run of vertices without changing the triangles. |
| **Clear Geometry** | Removes the mesh but keeps its settings and Material. |
| **Recalculate Normals**, **Recalculate Bounds** | Rebuild normals or bounds after editing vertices. |

Settings are **Material**, **Cast Shadows**, **Receive Shadows** and **Enable Collision** (off by default, 3D only). Collision rebuilds after each geometry change, so leave it off for meshes that change often. Generated geometry is not saved; it is discarded when Play stops.

## Outlines

An Outline draws a silhouette around an actor's geometry, in PBR and CEL projects.

| Setting | Default | Description |
| --- | --- | --- |
| **Enabled** | On | Shows the outline. |
| **Color** | Near black | Outline colour. |
| **Width** | 1 | Width in screen pixels, 0.25 to 8, independent of the actor's scale. |
| **Render Through Meshes** | Off | Shows the outline through other geometry, for example to highlight a target behind a wall. |

Outlines do not work in Scene Layers. For outlines on everything in a CEL project, see [CEL shading](lighting.md#cel-shading).

## 3D Text

3D Text draws flat, unlit text in the world. Lights and shadows do not affect it.

- Type in **Text**. Each new line goes above the previous one, and the actor's origin stays at the bottom of the block.
- **Size** (default 1), **Color** (default white) and **Alignment** (**Left**, **Center**, **Right**) set the look.
- **Font** takes a Font asset. Without one, or if the Font has no 3D typeface data, the text uses a built-in ASCII typeface; the Inspector then shows **Typeface**.

Scripts can change the text with the component's **Set Text** function. For text in HUDs and menus, use [2D Text](../components/2d-text.md) in a [Scene Layer](../scenes/scene-layers.md).
