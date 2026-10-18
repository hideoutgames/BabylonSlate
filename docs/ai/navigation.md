# Navigation

A navigation mesh (NavMesh) marks where AI characters can walk, so they can find paths around walls and each other.

## Bake a NavMesh

1. Choose **Place Actors > Navigation > NavMesh** to add a NavMesh actor to the scene.
2. Select it and tap **Bake NavMesh** in the **Inspector**. A dialog shows progress; you can cancel while it generates.
3. Turn on **Show Navmesh** in **Viewport Settings** (<kbd>Shift</kbd>+<kbd>N</kbd>) to see the walkable area in green.
4. Save the scene. The NavMesh is stored with it.

Bake again after you change level geometry. Turn on **Auto Bake On Save** to rebake every time you save the scene. Play and Export Game never bake: they use the NavMesh saved with the scene.

What the bake uses:

- **3D scenes:** the geometry of Mesh components, plus NavMesh Blockers.
- **2D scenes:** the X/Y plane is the floor. 2D Colliders, Tilemap collision and NavMesh Blockers become walls.

Blocking Volumes are physics only and do not affect the NavMesh.

## NavMesh settings

| Setting | Description |
| --- | --- |
| Cell Size, Cell Height | Detail of the mesh, in world units. Default 0.2. Smaller values follow geometry more closely but bake more slowly. |
| Walkable Slope Angle | Steepest walkable slope, in degrees. Default 60. |
| Walkable Height, Walkable Climb, Walkable Radius | The clearance, step height and width of the agents the mesh is built for. |
| Generate | **Solo** (default) or **Tiled**. |
| Support Dynamic Obstacles | Needed for blockers that move and for [Add Obstacle](../scripting/class/add-obstacle.md). Off by default. |
| Auto Bake On Save | Rebakes when you save the scene. Off by default. |
| Bake Bounds | Bakes only inside **Bake Bounds Min** and **Bake Bounds Max**, so a large scene bakes faster. |

See [NavMesh](../components/nav-mesh.md) for every setting.

## Move characters

1. Select the character and choose **Add Component > AI > Nav Agent**.
2. Set its **Radius** (default 0.5), **Height** (default 2), **Max Speed** (default 3.5) and **Max Acceleration** (default 8).
3. Move it from a graph with [Move To](../scripting/class/move-to.md), or from a Behaviour Tree with the [Move To](../scripting/behaviour-tree/move-to.md) or [Move To Blackboard Key](../scripting/behaviour-tree/move-to-blackboard-key.md) task.

Agents steer around each other and face the direction they move. A scene holds up to 128 agents.

| Node | Use |
| --- | --- |
| [Move To](../scripting/class/move-to.md) | Walks an agent to a point. The graph continues at once. |
| [Stop Movement](../scripting/class/stop-movement.md) | Stops the agent and clears its destination. |
| [Find Path To](../scripting/class/find-path-to.md) | Returns the corner points of a route, or an empty array. |
| [Is Path Valid](../scripting/class/is-path-valid.md) | Checks whether a route exists. |
| [Get Closest Navigable Point](../scripting/class/get-closest-navigable-point.md) | Snaps a position onto the NavMesh. |
| [Get Random Point In Radius](../scripting/class/get-random-point-in-radius.md) | Picks a walkable point, for wandering. |

## Block or slow areas

Choose **Place Actors > Navigation > NavMesh Blocker** and scale the actor to size the volume.

| Setting | Description |
| --- | --- |
| Kind | **Box** or **Cylinder**. A cylinder's X and Z scale are its diameters. |
| Area | **Unwalkable** removes the area from the NavMesh. **Cost** keeps it walkable but more expensive, so agents prefer other routes. |
| Cost | How expensive a Cost area is, above 1. Default 10. |
| Dynamic | Applies the blocker during Play instead of baking it. A dynamic Cost blocker follows the actor as it moves. A dynamic Unwalkable blocker is carved where it starts and needs **Support Dynamic Obstacles**. |

Unwalkable blockers that are not Dynamic are baked into the NavMesh, so rebake after moving them. Cost areas apply when Play starts. From scripts, [Add Obstacle](../scripting/class/add-obstacle.md) and [Remove Obstacle](../scripting/class/remove-obstacle.md) carve temporary holes.

## Debug navigation

Type these in the Play [console](../debugging/console.md):

- `shownav` shows the NavMesh and blockers.
- `showpathfinding` shows each agent's current path and destination.
- `shownavagent` shows agent bounds, velocity, names and movement state.

## Gotchas

- Without a baked NavMesh, or without a Nav Agent, move nodes do nothing and the Move To task fails. The **Output Log** warns once for each actor and reason during a Play session.
- Points more than 4 units from the NavMesh count as unreachable.
- On a dynamic Rigid Body in 3D, the Nav Agent steers horizontally and physics keeps gravity, so a falling agent still falls.
- Do not combine a Nav Agent with a Movement component on the same actor.

## Related

- [Nav Agent](../components/nav-agent.md)
- [NavMesh Blocker](../components/nav-mesh-blocker.md)
- [Behaviour Trees](behaviour-trees.md)
