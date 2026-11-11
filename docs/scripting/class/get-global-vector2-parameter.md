---
node: globalParameters.getVector2Parameter
---

# Get Global Vector2 Parameter

Returns a Vector2 parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md): the value set this Play session, else its default.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Collection | Global Parameter Collection | The collection that holds the parameter. |
| Parameter | String | The parameter's name. With **Collection** set and unwired, pick it from the list. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Vector2 |
| Found | Boolean |

## Notes

- **Found** is false, and **Value** 0, 0, when the collection does not hold a Vector2 parameter of that name.
