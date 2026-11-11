---
node: globalParameters.setVector4Parameter
---

# Set Global Vector4 Parameter

Sets a Vector4 parameter of a [Global Parameter Collection](../../assets/global-parameter-collection.md) for the rest of Play.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Collection | Global Parameter Collection | The collection that holds the parameter. |
| Parameter | String | The parameter's name. With **Collection** set and unwired, pick it from the list. |
| Value | Vector4 | The new value. Default 0, 0, 0, 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The value is the same for the whole game: every graph that reads the parameter uses it at once. It lasts until Play ends, also across Scene changes, and is never saved.
- A name the collection does not hold, or a parameter that is not a Vector4, is ignored, with one warning.
- The four components are passed to the shader as they are. A Color parameter converts its red, green and blue from display colour to linear; a Vector4 does not.
