# Set Capture Near Clip

Sets the near clip distance of a capture actor's camera.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Capture | RenderTargetCapture Reference |
| Near Clip | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Content closer than this distance is not drawn. The distance is in world units, and the smallest allowed value is 0.001.
- The far clip distance is kept above the near clip distance.
