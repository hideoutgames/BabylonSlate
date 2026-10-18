# Physics

Physics makes actors fall, collide and push each other while the game runs, in 3D or 2D scenes.

## Choose the physics world

Each scene simulates one physics world. Select nothing in the scene to show **Scene Settings** in the **Inspector**, then set:

| Setting | Description |
| --- | --- |
| Physics World | **3D (Havok)** or **2D (Rapier)**. New scenes follow their 3D or 2D viewport. |
| Gravity | World gravity in units per second squared. Default 0, -9.81, 0. |

A 2D world simulates on the X/Y plane. Bodies in a Scene Layer never collide with bodies in the scene.

## Make an actor simulate

An actor needs a **Rigid Body** and at least one **Collider** on the same actor. A Collider on an actor with no Rigid Body (and none of the [sources below](#collision-without-a-rigid-body)) is not simulated: it blocks nothing, raises no events and is not found by traces. For a trigger volume or a fixed collider, add a Rigid Body and set its **Motion Type** to **Static**.

1. Select the actor and choose **Add Component > Physics > Rigid Body**.
2. Choose **Add Component > Physics > Collider**. A new Collider is sized to fit the actor's primitive Mesh.
3. Set the Rigid Body's **Motion Type**.
4. Press **Play**.

| Motion Type | Use it for |
| --- | --- |
| Static | Floors, walls and props that never move. |
| Kinematic | Platforms and doors moved by scripts or animation. They push dynamic bodies but ignore forces. |
| Dynamic | Objects moved by gravity, impulses and collisions. |

On dynamic and kinematic bodies you can also set **Mass** (at least 0.001), **Gravity Scale**, **Linear Damping** and **Angular Damping**. A static body hides these rows.

Collider shapes are **box**, **sphere**, **capsule** and **cylinder** in 3D, and **box2d**, **circle** and **capsule2d** in 2D. Each Collider also has **Friction** (default 0.5), **Restitution** (bounciness, default 0), **Is Trigger**, **Layer** and **Collides With**. See [Collision](collision.md).

## Collision without a Rigid Body

These sources create a static body on their own, so they need no Rigid Body:

- A **Mesh** with **Collision** set to **Use Simple Collision** (the Model's simple shapes) or **Use Complex Collision** (its visible triangles, in the rest pose). 3D only. New Mesh components, including shapes from **Place Actors**, start at **No Collision**.
- A **Blocking Volume** from **Place Actors > Physics > Blocking Volume**: an invisible box the size of the actor's scale.
- A Tilemap with collision layers, enabled Landscape collisions and a Dynamic Runtime Mesh with **Enable Collision**.

A Collider on the same actor adds its shape to that static body, so it can be a trigger volume without a Rigid Body. A **Mesh** set to **No Collision** supplies no body, so its Collider still needs a Rigid Body.

A Mesh set to **Use Simple Collision** builds a body only when its Model has simple collision shapes. A Model imported with a skeleton starts with none: add shapes in the Model's **Colliders**, or use **Use Complex Collision**. Mesh collision is 3D only.

::: tip
A Ground shape placed from **Place Actors** does not stop anything until you give it collision. Set its Mesh **Collision** to **Use Simple Collision**.
:::

## Check your setup

- **Compiler Results** warns when:
  - a Collider has no Rigid Body, Mesh collision or other source of a body, so it is not simulated;
  - a Rigid Body has no shape to collide with: no Collider and no Mesh collision;
  - a Mesh is set to **Use Simple Collision** but its Model has no simple collision shapes, so it produces no collision;
  - a Mesh in a 2D scene has collision on, which only 3D physics supports. A Class does not know its scene, so only Scenes get this check.
- The editor always draws Collider outlines. Turn on **Show Collisions** in **Viewport Settings** (<kbd>Alt</kbd>+<kbd>C</kbd>) to also see Mesh collision.
- Turn on a Collider's **Render In Game** to draw its outline during Play, or type `showcollision` in the [console](../debugging/console.md).

## Drive physics from scripts

- [Add Impulse](../scripting/class/add-impulse.md) pushes a dynamic body. **Strength** defaults to 1.
- Setting a Rigid Body or Collider variable from a graph, such as **Mass** or **Is Trigger**, applies during Play.
- Moving an actor with a physics body from a script teleports the body.

## Scene Layers

Scene Layers have no physics by default. Turn on **Enable Physics** in the layer's settings to simulate its Rigid Bodies and Colliders in a separate 2D world with its own **Gravity**. See [Scene Layers](../scenes/scene-layers.md).

## In this section

- [Collision](collision.md): layers, hit and overlap events, traces and queries.
- [Movement](movement.md): character movement and jumping.
- [Constraints and Ragdolls](constraints.md): joints between bodies and skeletal ragdolls.
