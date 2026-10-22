---
node: scene-layer.getCameraLocation
---

# Get Scene Layer Camera Location

Returns the point of a Scene Layer at the centre of its camera's view.

## Inputs

| Pin | Type |
| --- | --- |
| Layer | SceneLayer Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Location | Vector 2 |

## Notes

- The location is in layer units. It is 0, 0 until a script moves the camera.
- Returns 0, 0 for a layer that has been removed.
