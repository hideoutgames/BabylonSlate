---
node: flow.event.sceneLayerActorSwitchedFrom
---

# Event On Scene Layer Actor Switched From

Runs on a Scene Layer Actor when a switcher replaces it with another.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Switcher | SceneLayerActorSwitcher Reference | The Scene Layer Actor Switcher that made the change. |
| Index | Integer | Position this actor had in the switcher's list. |

## Notes

- Runs immediately before the actor is removed.
- Only in Scene Layer Actor classes.
