# Set Shadows Enabled

Turns shadows on or off for the current session without losing their settings.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Enabled | Boolean |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Turning shadows back on restores the earlier shadow settings.
