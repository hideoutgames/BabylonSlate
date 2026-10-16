---
node: flow.event.sceneLayerActorSwitched
---

# Event On Scene Layer Actor Switched

Runs on a Scene Layer Actor Switcher after it has changed the actor on display.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Previous Actor | SceneLayerActor Reference | The actor that was on display before the switch. It is empty when none was shown. |
| Current Actor | SceneLayerActor Reference | The actor now on display. It is empty when the switch cleared the display. |
| Previous Index | Integer | Position of the previous actor, or -1 when none was shown. |
| Index | Integer | Position of the actor now on display, or -1 when none is shown. |

## Notes

- Runs after [**Event On Scene Layer Actor Switched From**](event-on-scene-layer-actor-switched-from.md) and [**Event On Scene Layer Actor Switched To**](event-on-scene-layer-actor-switched-to.md).
- Only in Scene Layer Actor Switcher classes.
