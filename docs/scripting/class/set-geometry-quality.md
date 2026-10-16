---
node: scalability.setGeometryQuality
---

# Set Geometry Quality

Turns automatic Model level of detail on or off and scales when simpler levels take over.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | GeometryQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- The distance scale runs from 0.25 to 4. A higher value keeps detailed levels visible for longer.
- Applies without reloading models.
