---
node: render-target.setActors
---

# Set Capture Actors

Sets the list of actors that a capture is limited to.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Capture | RenderTargetCapture Reference |
| Actors | Array of Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Used when **Capture Only Actors** is on. The whole list is rejected, and the capture keeps its current list, if it contains a destroyed actor or an actor from a Scene Layer.
