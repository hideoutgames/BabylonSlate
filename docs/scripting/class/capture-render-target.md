---
node: render-target.capture
---

# Capture Render Target

Requests one capture from a Render Target Capture actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Capture | RenderTargetCapture Reference | An actor with a Render Target Capture component. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Use it when **Capture Every Frame** is off. Several requests in one frame become a single capture.
- Nothing is captured while the capture is disabled or has no Render Target, and the editor viewport does not run captures.
