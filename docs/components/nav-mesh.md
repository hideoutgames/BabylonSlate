# NavMesh

Settings for baking the walkable surface that Nav Agents use to find paths.

## Add it

Choose **Place Actors > Navigation > NavMesh**. It is not in the **Add Component** menu. The Inspector lists it as Nav Mesh Component.

## Bake it

1. Select the NavMesh actor and choose **Bake NavMesh** on its component card.
2. Wait for the bake to finish. A dialog shows progress, and **Cancel** works while the mesh is being generated.
3. Turn on **Show Navmesh** in **Viewport Settings** to see the baked mesh in green.

The baked mesh is stored with the Scene. Bake again after you change level geometry. Play never bakes.

## Settings

| Setting | Description |
| --- | --- |
| Cell Size | Grid cell width, in world units. Smaller is more precise and slower. Default 0.2. |
| Cell Height | Grid cell height, in world units. Default 0.2. |
| Walkable Slope Angle | Steepest walkable slope, 0 to 90 degrees. Default 60. |
| Walkable Height | Least headroom, counted in cell heights. Default 2. |
| Walkable Climb | Tallest step an agent can climb, counted in cell heights. Default 2. |
| Walkable Radius | Distance kept from walls, counted in cells. Default 0.5. |
| Generate | **Solo** or **Tiled**. Tiled bakes in tiles, which suits large levels. Default Solo. |
| Support Dynamic Obstacles | Bakes a mesh that obstacles can cut at runtime. Always tiled. Default off. |
| Auto Bake On Save | Bakes whenever the Scene is saved. Default off. |
| Bake Bounds | Limits the bake to a box. Default off. |
| Bake Bounds Min, Bake Bounds Max | Corners of that box. Defaults -50, -10, -50 and 50, 10, 50. |

Advanced shape settings, which you can usually leave alone: **Max Edge Length** (12), **Max Simplification Error** (1.3), **Min Region Area** (8), **Merge Region Area** (20), **Max Verts Per Polygon** (6), **Detail Sample Distance** (6) and **Detail Sample Max Error** (1).

## Notes

- Works in world scenes and in Scene Layers.
- Heights and radii are counted in cells, not world units. To require 2 units of headroom with a Cell Height of 0.2, set Walkable Height to 10.
- In 3D the bake uses the geometry of Mesh components and static unwalkable [NavMesh Blockers](nav-mesh-blocker.md). In 2D it uses 2D Colliders, Tilemaps with collision, and those blockers.
- Dynamic and Cost blockers are not baked. They apply in Play.
- Runtime obstacles from [Add Obstacle](../scripting/class/add-obstacle.md) need Support Dynamic Obstacles.

## Related

- [Navigation](../ai/navigation.md)
- [Nav Agent](nav-agent.md)
