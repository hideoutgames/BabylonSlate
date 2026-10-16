# Set Water Quality

Caps the rendering cost of water, including shading, mesh density, reflections and wave detail.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | WaterQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Only drawing is affected; buoyancy and surface queries do not change.
- The device may limit some values, so read the values in use from [**Get Effective Scalability**](get-effective-scalability.md).
