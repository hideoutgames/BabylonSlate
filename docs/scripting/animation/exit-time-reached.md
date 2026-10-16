# Exit Time Reached

Returns true in the update where the clip passes a given point in time.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exit Time | Float | Point in the clip to test, where 1 is the end. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Boolean |

## Notes

- Exit Time is normalised: 0 is the start of the clip and 1 is the end. In a non-looping state it stays true once reached.
- In a looping state it fires once per loop, on the update that crosses the point; a value above 1 fires once, after that many loops.
- Only available in transition rule graphs, where it reads the state the transition leaves.
