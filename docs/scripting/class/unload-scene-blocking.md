# Unload Scene Blocking

Unloads a Scene Streaming Actor's Scene and waits until it is gone, pausing the game.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Target | SceneStreamingActor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Game simulation is paused until the Scene is unloaded, then **Then** runs.
- If the unload fails, an error is logged and the graph stops at this node without running **Then**.
- Latent: the node finishes later without pausing the rest of the game.
