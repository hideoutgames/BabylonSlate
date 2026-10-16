# Gradient

Maps a Value from 0 to 1 onto a colour gradient that you edit in Details.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Float | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Settings

| Setting | Description |
| --- | --- |
| Gradient Stops | The colour stops, from 2 to 32. Each has a Position from 0 to 1 and a Color. |

## Notes

- Values below the first stop or above the last stop use that stop's colour.
