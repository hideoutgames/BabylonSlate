# Movement

The Movement component walks, runs and jumps an actor across collision surfaces, driven by your input graphs.

## Add Movement

1. Select an actor in a 3D or 2D scene and choose **Add Component > General > Movement**.
2. Place the actor above a floor that has collision, without overlapping other colliders.
3. Connect input in the actor's Class graph (see below), then press **Play**.

Movement gives the actor its own upright capsule, centred on the actor. World +Y is up in both 3D and 2D. In 3D the actor moves on X and Z; in 2D it moves on X. Y is used for jumping and falling.

Add a dynamic [Rigid Body](../components/rigid-body.md) to the same actor to let physics move it instead. See [Movement with a Rigid Body](#movement-with-a-rigid-body).

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
| Gravity Scale | 1 | Multiplier for the scene's gravity. Ignored beside a dynamic Rigid Body, which uses its own Gravity Scale. |
| Air Control | 0.35 | Steering while airborne, from 0 (keep momentum) to 1 (full control). |
| Max Fall Speed | 40 | Fastest downward speed. |
| Input Space | World | 3D only. **World** or **Actor**: whether Convert Input uses fixed directions or the actor's heading. |
| Input Yaw | 0 | 3D only. Turns input directions around world Y, in degrees. Set it from a graph for camera-relative controls. |
| Input Scale | 1 | Scales input strength in Convert Input. |
| Dead Zone | 0.1 | Small input values that Convert Input ignores. |
| Radius | 0.4 | Capsule radius in world units. |
| Height | 1.8 | Total capsule height in world units. |
| Max Slope Angle | 50° | Steepest surface that counts as ground. |
| Ground Snap Distance | 0.1 | Keeps the actor on the ground over small drops. Beside a dynamic Rigid Body, how far below the actor still counts as ground. |
| Coyote Time | 0.1 s | A jump still works this long after walking off an edge. |
| Jump Buffer Time | 0.1 s | A jump pressed this long before landing still happens. |

## Movement with a Rigid Body

The [Rigid Body](../components/rigid-body.md)'s **Motion Type** decides who moves the actor.

- **No Rigid Body, or Kinematic.** Movement moves its own capsule with collision and its own gravity. [Add Impulse](../scripting/class/add-impulse.md) adds the impulse divided by the actor's mass to Movement's velocity: 1 without a Rigid Body, or the Kinematic Rigid Body's **Mass**. A launch pad can launch a walker this way.
- **Dynamic.** Physics moves the actor, and Movement steers it every physics step. It moves the body's horizontal speed toward the input using **Max Speed**, **Acceleration**, **Braking** and **Air Control**, and leaves the vertical speed to physics. The Rigid Body's mass, **Gravity Scale**, damping, collisions and impulses all apply.
- **Static.** A static body cannot move, so Movement stops and **Compiler Results** warns.

With a Dynamic Rigid Body:

- **Jump** adds **Jump Speed** while the actor is grounded, with **Coyote Time** and **Jump Buffer Time**. **Max Fall Speed** limits the downward speed.
- The actor keeps the shape of its [Colliders](../components/collider.md) or Mesh collision. With no solid shape, Movement adds its capsule from **Radius** and **Height**.
- The body stays upright. Collisions and impulses never turn it, in 3D or 2D, so set its facing from a graph.
- The actor counts as grounded when a short check below it finds a surface no steeper than **Max Slope Angle**, within **Ground Snap Distance**. Is Grounded, Is In Air, Landed, Left Ground and Jumped work as without a Rigid Body. Velocity, Speed and Is Moving read the body's velocity.
- In 2D, horizontal means X and up means Y.
- Add Impulse pushes the body. Movement then slows it at the **Braking** rate, or **Acceleration** while input is held.
- Give the actor's Collider a Friction of 0 to keep it from sticking to walls. Without a Collider, the capsule has no friction.
- The check below the actor ignores collision layers, so a surface on a layer the actor does not collide with can still count as ground.

## Gotchas

- Do not combine Movement with a Nav Agent, Ragdoll, Water Buoyancy, a second Movement or a Static Rigid Body on the same actor; **Compiler Results** warns that Movement cannot simulate.
- Without a Rigid Body, or with a Kinematic one, Colliders and Mesh collision on the same actor do not change the capsule. Actor scale does not resize it either; set **Radius** and **Height**.
- Movement covers walking and jumping. It has no flying mode, and moving platforms do not reliably carry the character.
- For a simple sliding move without Movement, use [Move Character](../scripting/class/move-character.md) on an actor with a collider.

## Related

- [Movement component](../components/movement.md)
- [Input](../input/index.md)
- [Collision](collision.md)
