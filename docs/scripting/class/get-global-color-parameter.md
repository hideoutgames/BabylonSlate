---
node: globalParameters.getColorParameter
---

# Get Global Color Parameter

Returns a parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md): the value set this Play session, else its default.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Collection | Global Parameter Collection | The collection that holds the parameter. |
| Parameter | String | The parameter's name. With **Collection** set and unwired, pick it from the list. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Color |
| Found | Boolean |

## Notes

- **Found** is false, and **Value** 0, 0, 0, 1, when the collection does not hold a Color parameter of that name.
