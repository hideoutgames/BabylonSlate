# Set Post Processing Quality

Scales the resolution of post-process passes that allow scalable resolution.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | PostProcessingQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Resolution scale runs from 0.25 to 1. Only passes with **Scalable Resolution** turned on are affected.
- Whether each effect is enabled does not change.
