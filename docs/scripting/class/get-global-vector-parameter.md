---
node: globalParameters.getVectorParameter
---

# Get Global Vector Parameter

Returns a parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md): the value set this Play session, else its default.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Collection | Global Parameter Collection | The collection that holds the parameter. |
| Parameter | String | The parameter's name. With **Collection** set and unwired, pick it from the list. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Vector3 |
| Found | Boolean |

## Notes

- It reads a Vector2 or Vector3 parameter; a Vector2 reads with **Z** 0.
- **Found** is false, and **Value** 0, 0, 0, when the collection does not hold such a parameter of that name.
