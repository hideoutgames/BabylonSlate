---
node: transform.teleport
---

# Teleport

Moves and turns the actor at once, without sweeping through what lies between.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference |  |
| Dest Location | Vector 3 |  |
| Dest Rotation | Rotator |  |
| Reset Velocity | Boolean | Stop a physics body's movement as it arrives. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Location and rotation are relative to the parent for an attached actor, as [Set Actor Location](set-actor-location.md) is.
- A physics body keeps its velocity unless **Reset Velocity** is on.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
