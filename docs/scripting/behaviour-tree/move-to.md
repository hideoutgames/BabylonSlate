---
node: bt.task.moveTo
---

# Move To

Moves the actor to a world position along the navigation mesh.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Destination |  | The world position to move to. |
| Accept Radius | 0.5 | How close to the destination, in metres, the actor must get to count as arrived. The default is 0.5. |

## Notes

- The task stays running until the actor is within **Accept Radius** of the destination, then succeeds.
- It needs a baked NavMesh in the scene and a **Nav Agent** component on the actor, otherwise it fails. The **Output Log** warns once for each actor and reason during a Play session.
- If the tree aborts the task, the actor stops.
