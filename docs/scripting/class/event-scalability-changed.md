---
node: flow.event.scalabilityChanged
---

# Event Scalability Changed

Runs when the renderer confirms or rejects the latest quality request.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Settings | ScalabilitySnapshot | The requested and effective rendering settings, and the result of the request. |

## Notes

- Read **Settings** for the result and the settings now in effect.
- Results for a request that a newer one has replaced are ignored.
- Available on Actors, components, the Game Instance and Game Subsystems.
