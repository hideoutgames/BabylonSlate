# Set Anim Graph Variable

Sets a variable on an Animation Graph component.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | AnimationGraphComponent Reference | The Animation Graph component to change. |
| Name | String | Name of the Animation Graph variable. |
| Value | Any |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Transition rules and the Animation Object graph read the new value the next time the graph updates.
- Does nothing if the target is invalid. Only available in Actor class graphs.
