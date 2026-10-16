# Create Scene Layer

Creates a Scene Layer from an asset and waits until it is ready.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Asset | SceneLayer Asset |  |
| Z Order | Integer | Draw order between layers. A layer with a higher value draws on top of one with a lower value. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Layer | SceneLayer Reference | The new Scene Layer. Pass it to [**Remove Scene Layer**](remove-scene-layer.md) or the post-processing nodes. |

## Notes

- The layer draws over the world. Waits until it has loaded and drawn once, and fails if that takes longer than 30 seconds.
- A layer created here stays when the Scene changes, until you remove it.
- Latent: the node finishes later without pausing the rest of the game.
