# Set Frame Cap

Limits how many frames per second the game presents.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Frames Per Second | Float | Highest number of frames to present each second. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Must be greater than 0, otherwise **Result** reports a failure.
- Only presentation is limited. The fixed simulation step does not change.
