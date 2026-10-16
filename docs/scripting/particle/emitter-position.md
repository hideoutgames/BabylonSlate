# Emitter Position

Returns the world-space position of the emitter.

## Outputs

| Pin | Type |
| --- | --- |
| Emitter Position | Vector 3 |

## Notes

- It cannot be used for **Emit Rate**: that input is read before the emitter exists, so the graph fails to build.
