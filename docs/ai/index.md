# AI

Haptic builds game AI from Behaviour Trees that decide what to do, Blackboards that remember what the AI knows, and navigation that moves characters around the level.

## The pieces

| Piece | What it does |
| --- | --- |
| [Behaviour Tree](../assets/behaviour-tree.md) asset | A tree of tasks and conditions that picks the actor's next action. |
| [Blackboard](../assets/blackboard.md) asset | Named values the tree reads and writes, such as a target actor or a patrol point. |
| [Behaviour Tree](../components/behaviour-tree.md) component | Runs a tree on an actor during Play. |
| [NavMesh](../components/nav-mesh.md) | The baked walkable area of a scene. |
| [Nav Agent](../components/nav-agent.md) component | Lets an actor walk the NavMesh and avoid other agents. |
| [NavMesh Blocker](../components/nav-mesh-blocker.md) | Removes an area from the NavMesh or makes it costly to cross. |

Behaviour Trees and Blackboards are created from **New Asset > AI**. NavMesh and NavMesh Blocker actors come from **Place Actors > Navigation**. The Behaviour Tree and Nav Agent components are under **Add Component > AI**.

## A patrolling guard

1. Place a NavMesh, tap **Bake NavMesh** and save the scene.
2. Add a **Nav Agent** to the guard.
3. Create a Blackboard with a Vector 3 key for the next patrol point.
4. Create a Behaviour Tree that uses the Blackboard: a Sequence with **Move To Blackboard Key** and **Wait**, plus a custom task or service that sets the next point.
5. Add a **Behaviour Tree** component to the guard and pick the tree.
6. Press **Play**.

## Debug AI

During Play, type these in the [console](../debugging/console.md):

| Command | Shows |
| --- | --- |
| `behaviourtreedebug` | The Behaviour Tree Debugger: each actor's running node, results and Blackboard values. |
| `shownav` | The NavMesh and blockers. |
| `showpathfinding` | Each agent's current path. |
| `shownavagent` | Agent bounds, velocity and state. |

## In this section

- [Behaviour Trees](behaviour-trees.md): Behaviour Trees and Blackboards, custom tasks and debugging.
- [Navigation](navigation.md): NavMesh, Nav Agents, blockers and pathfinding.
