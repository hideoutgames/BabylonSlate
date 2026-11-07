---
node: camera.getSceneCameraManager
---

# Get Scene Camera Manager

Returns the Scene Camera Manager, which reports what the Scene's view looks through.

## Outputs

| Pin | Type |
| --- | --- |
| Scene Camera Manager | SceneCameraManager Reference |

## Notes

- Drag from **Scene Camera Manager** to use its members:
  - **Get Layer Camera**: the current Scene's [Layer Camera](../../graphics/cameras.md#layer-camera).
  - **Get Camera Actor**: the actor the view looks through, or None while the Layer Camera is in view.
  - **Get Camera Component**: that actor's Camera component in view, or None while the Layer Camera is in view.
- A Scene Layer has its own camera, which the manager does not report. Use **Get Layer Camera** on the Scene Layer, or on one of its actors.
- See [Script the camera](../../graphics/cameras.md#script-the-camera).
