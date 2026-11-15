---
node: anim.actor.jumpToState
---

# Jump To State

Switches an Animation Graph to a named state, skipping its transitions.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | AnimationGraphComponent Reference | The Animation Graph component to control. |
| State | String | Name or ID of the state to switch to. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The jump happens on the next animation update, and the state starts from the beginning of its clip.
- It switches the graph's State Machine with no blend.
- Does nothing if no state matches. Only available in Actor class graphs.
