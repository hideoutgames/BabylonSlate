# Movement

The Movement component walks, runs and jumps an actor across collision surfaces, driven by your input graphs.

## Add Movement

1. Select an actor in a 3D or 2D scene and choose **Add Component > General > Movement**.
2. Place the actor above a floor that has collision, without overlapping other colliders.
3. Connect input in the actor's Class graph (see below), then press **Play**.

Movement gives the actor its own upright capsule, centred on the actor. World +Y is up in both 3D and 2D. In 3D the actor moves on X and Z; in 2D it moves on X. Y is used for jumping and falling.

Movement does not work in Scene Layers.

## Connect input

1. Add an [Event Input Axis](../scripting/class/event-input-axis.md) for a 2D axis, such as Move.
2. From **Held**, call **Convert Input** on the Movement component with the axis **Value**, then pass its **Direction** to **Set Movement Input**.
3. From **Released**, call **Set Movement Input** with a zero direction, so the actor stops accelerating.
4. Add an [Event Input Action](../scripting/class/event-input-action.md) for Jump and call **Jump** from **Started**.

A 1D axis works too: use its value as X and leave Y at zero.

## Functions

| Function | Description |
| --- | --- |
| Convert Input | Turns a Vector 2 into a world direction, applying **Dead Zone**, **Input Scale**, **Input Space** and a yaw in degrees. 2D uses X only. |
| Set Movement Input | Keeps moving in a world direction until you set another one. |
| Add Movement Input | Adds a direction for the next physics tick only. Call it every tick while held. |
| Set Velocity | Replaces the world velocity, in units per second. |
| Add Velocity | Adds a velocity change, for knockback or launch pads. |
| Jump | Requests a jump, using **Coyote Time** and **Jump Buffer Time**. |
| Stop Immediately | Clears velocity, input and any buffered jump. |

Combined input is limited to full strength, so diagonal movement is not faster.

Read the current state from **Velocity**, **Speed** (horizontal), **Is Grounded**, **Is In Air** and **Is Moving**. React to changes with [Event On Movement Started](../scripting/class/event-on-movement-started.md), [Stopped](../scripting/class/event-on-movement-stopped.md), [Jumped](../scripting/class/event-on-movement-jumped.md), [Left Ground](../scripting/class/event-on-movement-left-ground.md) and [Landed](../scripting/class/event-on-movement-landed.md).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Enabled | On | Off stops movement but keeps the capsule. |
| Max Speed | 5 | Top speed from input, in units per second. |
| Acceleration | 30 | How quickly movement reaches its target speed. |
| Braking | 40 | How quickly the actor slows when input stops. |
| Jump Speed | 6 | Upward speed when a jump starts. |
| Gravity Scale | 1 | Multiplier for the scene's gravity. |
| Air Control | 0.35 | Steering while airborne, from 0 (keep momentum) to 1 (full control). |
| Max Fall Speed | 40 | Fastest downward speed. |
| Input Space | World | 3D only. **World** or **Actor**: whether Convert Input uses fixed directions or the actor's heading. |
| Input Yaw | 0 | 3D only. Turns input directions around world Y, in degrees. Set it from a graph for camera-relative controls. |
| Input Scale | 1 | Scales input strength in Convert Input. |
| Dead Zone | 0.1 | Small input values that Convert Input ignores. |
| Radius | 0.4 | Capsule radius in world units. |
| Height | 1.8 | Total capsule height in world units. |
| Max Slope Angle | 50° | Steepest surface that counts as ground. |
| Ground Snap Distance | 0.1 | Keeps the actor on the ground over small drops. |
| Coyote Time | 0.1 s | A jump still works this long after walking off an edge. |
| Jump Buffer Time | 0.1 s | A jump pressed this long before landing still happens. |

## Gotchas

- Movement supplies its own body. Do not add a Rigid Body, Nav Agent, Ragdoll, Water Buoyancy or a second Movement to the same actor; **Compiler Results** warns that Movement cannot simulate.
- Colliders and Mesh collision on the same actor do not change the capsule. Actor scale does not resize it either; set **Radius** and **Height**.
- Movement covers walking and jumping. It has no flying mode, and moving platforms do not reliably carry the character.
- For a simple sliding move without Movement, use [Move Character](../scripting/class/move-character.md) on an actor with a collider.

## Related

- [Movement component](../components/movement.md)
- [Input](../input/index.md)
- [Collision](collision.md)
