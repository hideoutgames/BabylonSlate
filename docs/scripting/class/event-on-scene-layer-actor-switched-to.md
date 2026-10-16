---
node: flow.event.sceneLayerActorSwitchedTo
---

# Event On Scene Layer Actor Switched To

Runs on a Scene Layer Actor when a switcher makes it the actor on display.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Switcher | SceneLayerActorSwitcher Reference | The Scene Layer Actor Switcher that made the change. |
| Index | Integer | Position of this actor in the switcher's list. |

## Notes

- Runs before the switcher's own [**Event On Scene Layer Actor Switched**](event-on-scene-layer-actor-switched.md).
- Only in Scene Layer Actor classes.
