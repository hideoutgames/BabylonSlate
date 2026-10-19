---
node: anim.actor.getVariable
---

# Get Anim Graph Variable

Returns the value of a variable on an Animation Graph component.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | AnimationGraphComponent Reference | The Animation Graph component to read, for example from a [**Get Variable**](get-variable.md) node for that component. |
| Name | String | Name of the Animation Graph variable. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Any | The variable's current value. |

## Notes

- **Name** must match a variable defined in the Animation Graph. An unknown name returns an empty value, and an empty target returns an empty value and logs an error.
- Only available in Actor class graphs.
