# Unregister Scene Layer Post-Processing

Removes a post-process Material from the effects applied to a Scene Layer.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Layer | SceneLayer Reference |
| Material | Material Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- If the Material is not in the layer's effects, an error is logged and play continues.
