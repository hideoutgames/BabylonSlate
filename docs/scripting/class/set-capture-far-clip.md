# Set Capture Far Clip

Sets the far clip distance of a capture actor's camera.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Capture | RenderTargetCapture Reference |
| Far Clip | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Content further away than this distance is not drawn. The distance is in world units.
- The value is kept above the near clip distance.
