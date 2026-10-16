# Gate

Passes execution through only while the gate is open.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Enter | Exec | Runs Exit when the gate is open. Does nothing when it is closed. |
| Open | Exec | Opens the gate. |
| Close | Exec | Closes the gate. |
| Toggle | Exec | Opens the gate if it is closed, and closes it if it is open. |

## Outputs

| Pin | Type |
| --- | --- |
| Exit | Exec |

## Notes

- The gate starts closed.
- Each object keeps its own gate state.
