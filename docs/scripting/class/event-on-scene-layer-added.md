# Event On Scene Layer Added

Runs on a Scene Subsystem when a Scene Layer is created while the subsystem exists.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Scene Layer | SceneLayer Reference | The Scene Layer that was added. |

## Notes

- Scene Layers that existed before the subsystem was created are not reported.
- Only in Scene Subsystem classes.
