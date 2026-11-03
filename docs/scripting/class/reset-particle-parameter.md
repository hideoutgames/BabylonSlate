---
node: particles.resetParameter
---

# Reset Particle Parameter

Drops the value a Set Particle Parameter node gave a parameter of the particle effects on an actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor whose particle components to reset. Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Name | String | The parameter name, as the Particle System lists it. |

## Outputs

| Pin | Type |
| --- | --- |
| Success | Boolean |

## Notes

- Each Particle component whose Particle System declares **Name** goes back to the Particle System's default.
- **Success** is false when no Particle System on the actor declares **Name**.
- The Particle component has a **Reset Parameter** function that resets only that component.
