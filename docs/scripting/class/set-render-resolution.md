---
node: scalability.setResolution
---

# Set Render Resolution

Locks the rendered output to a fixed width and height, with black bars if needed.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Width | Integer |
| Height | Integer |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Width and Height are in pixels.
- [**Reset to Project Defaults**](reset-to-project-defaults.md) restores the output size set in the project.
