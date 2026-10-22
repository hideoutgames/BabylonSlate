---
node: scene-layer.getCameraRotation
---

# Get Scene Layer Camera Rotation

Returns the angle of a Scene Layer's camera, in degrees.

## Inputs

| Pin | Type |
| --- | --- |
| Layer | SceneLayer Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Rotation | Float |

## Notes

- Returns the angle as it was last set, without wrapping it to 0–360. It is 0 until a script turns the camera, and for a layer that has been removed.
