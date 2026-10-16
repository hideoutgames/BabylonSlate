# Set Antialiasing

Turns FXAA antialiasing on or off for the current session.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Fxaa Enabled | Boolean |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- The renderer prepares the replacement before it confirms the request, so **Result** is pending at first.
