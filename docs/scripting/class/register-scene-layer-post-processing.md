# Register Scene Layer Post-Processing

Adds a post-process Material to the effects applied to a Scene Layer.

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

- The Material must use the Post Process domain. Any other Material is reported as an error when the graph is checked.
- The effect is added after the layer's existing ones.
