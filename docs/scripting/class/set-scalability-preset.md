# Set Scalability Preset

Applies a Low, Medium, High or Ultra quality tier to the current session.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Preset | ScalabilityPreset |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Sets shadows, resolution, textures, geometry, water, lighting and post-processing together.
- Render mode, CEL outline appearance and artistic effects are left as they are.
- Applies to the current session only and does not change project settings.
