---
node: particles.getFloatParameter
---

# Get Particle Float Parameter

Returns a parameter of the particle effects on an actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor to read. Left unconnected the pin shows **Self** and reads the actor running the graph. |
| Name | String | The parameter name, as the Particle System lists it. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |
| Found | Boolean |

## Notes

- Reads the first Particle component on the actor whose Particle System declares **Name**: the value set while playing, else the component's override (its **Parameters** in the Inspector), else the Particle System's default.
- **Found** is false, and **Value** is zero, when no Particle System on the actor declares **Name**.
- The Particle component has a **Get Float Parameter** function that reads only that component.
