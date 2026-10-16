# Get Capture Actors

Returns the list of actors that a capture is limited to.

## Inputs

| Pin | Type |
| --- | --- |
| Capture | RenderTargetCapture Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Actors | Array of Actor Reference |

## Notes

- Used when **Capture Only Actors** is on. Actors that no longer exist are left out.
- Changing the returned array does not change the capture until you call [**Set Capture Actors**](set-capture-actors.md).
