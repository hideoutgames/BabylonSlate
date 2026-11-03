---
node: particles.setColorParameter
---

# Set Particle Color Parameter

Sets a parameter of the particle effects on an actor while they run.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor whose particle components to change. Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Name | String | The parameter name, as the Particle System lists it. |
| Value | Color | The new value. Red, green, blue and alpha. |

## Notes

- Every Particle component on the actor whose Particle System declares **Name** takes the value at once, without restarting. A component whose System does not declare it is left alone.
- The value lasts for the session and is never saved. [Reset Particle Parameter](reset-particle-parameter.md) goes back to the component's override or the default.
- A name no Particle System on the actor declares does nothing, and the **Output Log** shows a warning once per name.
- The Particle component has a **Set Color Parameter** function that changes only that component.
