# Movement

Walks and jumps an actor as a character: a capsule that follows input, gravity and ground.

## Add it

Select an actor, then choose **Add Component > General > Movement**. Place the actor above a collision surface.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns movement on or off. Off stops movement but keeps the capsule. Default on. |
| Max Speed | Top speed from input, in units per second. Default 5. |
| Acceleration | How quickly it reaches that speed. Default 30. |
| Braking | How quickly it slows when input stops. Default 40. |
| Jump Speed | Upward speed at the start of a jump. Default 6. |
| Gravity Scale | Multiplies the scene's gravity. Default 1. |
| Air Control | Steering while airborne, 0 to 1. 0 keeps momentum. Default 0.35. |
| Max Fall Speed | Top downward speed. Default 40. |
| Input Space | 3D only. **World** or **Actor**: whether input directions are fixed or relative to the actor. Default World. |
| Input Yaw | 3D only. Turns input directions around the world Y axis, in degrees. Set it from a graph for camera-relative controls. Default 0. |
| Input Scale | Scales input strength before it is limited to full movement. Default 1. |
| Dead Zone | Small inputs ignored, 0 to 0.999. Default 0.1. |
| Radius | Capsule radius in world units. Default 0.4. |
| Height | Total capsule height, including the rounded ends. Default 1.8. |
| Max Slope Angle | Steepest surface treated as ground, in degrees. Default 50. |
| Ground Snap Distance | Stays attached to ground over small drops. Default 0.1. |
| Coyote Time | Allows a jump briefly after walking off an edge, in seconds. Default 0.1. |
| Jump Buffer Time | Remembers a jump pressed right before landing, in seconds. Default 0.1. |

## Drive it from a graph

1. Add an [Event Input Axis](../scripting/class/event-input-axis.md) for a 2D Input Axis. Connect **Held** through **Convert Input** to **Set Movement Input**, and connect **Released** to **Set Movement Input** with a zero direction.
2. Connect [Event Input Action](../scripting/class/event-input-action.md) **Started** to **Jump**.

Other functions are **Add Movement Input**, **Set Velocity**, **Add Velocity** and **Stop Immediately**. Read **Velocity**, **Speed**, **Is Grounded**, **Is In Air** and **Is Moving**. Events: [Event On Movement Started](../scripting/class/event-on-movement-started.md), [Stopped](../scripting/class/event-on-movement-stopped.md), [Jumped](../scripting/class/event-on-movement-jumped.md), [Left Ground](../scripting/class/event-on-movement-left-ground.md) and [Landed](../scripting/class/event-on-movement-landed.md).

## Notes

- World scenes only. It works in 3D and 2D physics.
- World Y is up. Ground movement uses X and Z in 3D, and X in 2D.
- Movement brings its own capsule. Actor scale does not resize it, so change Radius and Height. Mesh collision and Colliders add no shapes while Movement owns the actor.
- Use one Movement per actor. A Rigid Body, Nav Agent, Ragdoll, Water Buoyancy or second Movement on the same actor stops it. Compiler Results reports this.
- Moving platforms are not guaranteed to carry the character.

## Related

- [Movement](../physics/movement.md)
- [Move Character](../scripting/class/move-character.md)
