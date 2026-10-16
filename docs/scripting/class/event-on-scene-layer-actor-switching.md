---
node: flow.event.sceneLayerActorSwitching
---

# Event On Scene Layer Actor Switching

Runs on a Scene Layer Actor Switcher immediately before it changes the actor on display.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Previous Actor | SceneLayerActor Reference | The actor on display before the switch. It is empty when none was shown. |
| Current Actor | SceneLayerActor Reference | Still the previous actor at this point. |
| Previous Index | Integer | Position of the previous actor, or -1 when none was shown. |
| Index | Integer | Position being switched to, or -1 to show no actor. |

## Notes

- Current Actor is still the actor on display, the same as Previous Actor.
- Only in Scene Layer Actor Switcher classes.
