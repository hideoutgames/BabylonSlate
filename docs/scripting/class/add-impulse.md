---
node: physics.addImpulse
---

# Add Impulse

Applies an instant push to an actor's dynamic Rigid Body.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference |  |
| Impulse | Vector 3 |  |
| Strength | Float | Multiplies the impulse. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The push is **Impulse** multiplied by **Strength**, applied at the body's centre of mass in world directions.
- Nothing happens unless the actor has a Rigid Body whose motion type is Dynamic, or a [Movement](../../components/movement.md) component that moves its own capsule.
- On a Movement actor without a Dynamic Rigid Body, the push changes Movement's velocity by **Impulse** × **Strength** divided by the mass (1, or a Kinematic Rigid Body's **Mass**). Movement then moves the actor with collision and its own gravity.
- On a Movement actor with a Dynamic Rigid Body, the push moves the body, and Movement slows it down.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens and an error is logged.
