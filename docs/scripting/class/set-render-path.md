---
node: scalability.setRenderPath
---

# Set Render Path

Requests the render path: Auto, Forward or Clustered Forward.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Render Path | RenderPath |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- The renderer can fall back when the backend or the Scene does not support the request.
- Read **Fallback Reason** from [**Get Effective Scalability**](get-effective-scalability.md) to see why a request was not honoured.
