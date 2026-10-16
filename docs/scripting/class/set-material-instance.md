# Set Material Instance

Assigns a Material Instance to a mesh component and returns its Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | ActorComponent Reference | A Mesh or Dynamic Runtime Mesh component. |
| Instance | MaterialInstance Asset |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Material | MaterialObject Reference | The Material Object for the new assignment. Use it with the Material Parameter nodes. |

## Notes

- Waits until the instance is ready, and the current material stays visible until then.
- Works on Mesh and Dynamic Runtime Mesh components; for any other target **Material** is empty.
- Setting the instance that is already assigned keeps its runtime parameter values.
- Latent: the node finishes later without pausing the rest of the game.
