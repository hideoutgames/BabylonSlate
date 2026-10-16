---
node: scalability.setRenderMode
---

# Set Render Mode

Switches between PBR and CEL rendering for the current session.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Mode | RenderMode |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- PBR is physically based shading. CEL is the stylised, banded look.
- **Result** stays pending until the materials are ready.
