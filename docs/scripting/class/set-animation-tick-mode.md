---
node: anim.actor.setTickMode
---

# Set Animation Tick Mode

Changes when an Animation Graph runs, for example to stop animating characters nobody can see.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | AnimationGraphComponent Reference | The Animation Graph component to change. |
| Tick Mode | AnimationTickMode | Always by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Always** runs the graph and poses the actor every frame.
- **When Visible** runs the graph every frame, so its states, variables and Animation Events behave as with Always, but poses the actor only while a camera can see it or its shadow. When it comes into view it shows its current pose at once.
- **Never** stops the graph: the actor holds its pose, the State Machine stays where it is and no Animation Events fire. Setting it back to Always or When Visible carries on from there.
- Does nothing if Target is not an Animation Graph component.
