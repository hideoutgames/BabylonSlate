# Camera Position

Returns the world-space position of the active camera.

## Outputs

| Pin | Type |
| --- | --- |
| Camera Position | Vector 3 |

## Notes

- It cannot be used for **Emit Rate**: that input is read before the emitter exists, so the graph fails to build.
