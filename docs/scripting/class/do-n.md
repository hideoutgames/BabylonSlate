# Do N

Lets execution through up to N times, then blocks it until it is reset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| N | Integer | How many times Out may run before the node stops passing execution through. |
| Reset | Exec | Sets the count back to 0 so Out can run again. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Counter | Integer | How many times Out had run before this pass. It is 0 on the first pass. |

## Notes

- Once Out has run N times, further runs of **In** do nothing until **Reset** runs.
- Each object keeps its own count.
