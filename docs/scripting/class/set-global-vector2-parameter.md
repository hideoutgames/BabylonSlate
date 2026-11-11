---
node: globalParameters.setVector2Parameter
---

# Set Global Vector2 Parameter

Sets a Vector2 parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md) for the rest of Play.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Collection | Global Parameter Collection | The collection that holds the parameter. |
| Parameter | String | The parameter's name. With **Collection** set and unwired, pick it from the list. |
| Value | Vector2 | The new value. Default 0, 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The value is the same for the whole game: every graph that reads the parameter uses it at once. It lasts until Play ends, also across Scene changes, and is never saved.
- A name the collection does not hold, or a parameter that is not a Vector2, is ignored, with one warning.
