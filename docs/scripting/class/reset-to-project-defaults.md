---
node: scalability.reset
---

# Reset to Project Defaults

Clears all temporary quality and rendering changes made during this session.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Scene and project defaults apply again.
- Player preferences that your game saves itself are not affected.
