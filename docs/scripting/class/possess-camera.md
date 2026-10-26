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
- Pick an actor that has a Camera component.
