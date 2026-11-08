---
node: camera.possess
---

# Possess Camera

Makes the camera on an actor the view the player sees.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- The view looks through the actor's first Camera component.
- Connect a None reference to return the view to the Scene's [Layer Camera](../../graphics/cameras.md#layer-camera). An actor without a Camera component does the same, with a warning in the **Output Log**.
- The view also returns to the Layer Camera when the possessed actor is destroyed.
- Works whatever the Scene's **Default Camera** is. See [Choose the camera in view](../../graphics/cameras.md#choose-the-camera-in-view).
- To move the view to the camera smoothly instead of cutting, use [**Set View Target With Blend**](set-view-target-with-blend.md).
