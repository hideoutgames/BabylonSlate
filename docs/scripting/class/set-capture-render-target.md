---
node: render-target.setRenderTarget
---

# Set Capture Render Target

Changes the Render Target that a Render Target Capture actor draws into.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Capture | RenderTargetCapture Reference |
| Render Target | RenderTarget Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- A Render Target that has not loaded yet loads first; the capture keeps drawing into its current one until then. See [Soft and Hard assets](../variables.md#soft-and-hard-assets).
- Does nothing if the actor has no Render Target Capture component.
