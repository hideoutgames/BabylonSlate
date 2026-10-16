# Duration Seconds

Returns the length in seconds of the current state's clip.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- The state's playback speed is taken into account. A state with no clip counts as 1 second.
- Only available in transition rule graphs, where it reads the state the transition leaves.
