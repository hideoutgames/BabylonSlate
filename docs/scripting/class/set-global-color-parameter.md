---
node: globalParameters.setColorParameter
---

# Set Global Color Parameter

Sets a parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md) for the rest of Play.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Collection | Global Parameter Collection | The collection that holds the parameter. |
| Parameter | String | The parameter's name. With **Collection** set and unwired, pick it from the list. |
| Value | Color | The new value. Default 1, 1, 1, 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- It sets only a Color parameter.
- The value is the same for the whole game: every graph that reads the parameter uses it at once. It lasts until Play ends, also across Scene changes, and is never saved.
- A name the collection does not hold, or a parameter of another type, is ignored, with one warning.
